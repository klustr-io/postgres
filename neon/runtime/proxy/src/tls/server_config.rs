use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use itertools::Itertools;
use rustls::crypto::ring::{self, sign};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::sign::CertifiedKey;
use x509_cert::der::{Reader, SliceReader};

use super::{PG_ALPN_PROTOCOL, TlsServerEndPoint};

pub struct TlsConfig {
    // unfortunate split since we cannot change the ALPN on demand.
    // <https://github.com/rustls/rustls/issues/2260>
    pub http_config: Arc<rustls::ServerConfig>,
    pub pg_config: Arc<rustls::ServerConfig>,
    pub common_names: HashSet<String>,
    pub cert_resolver: Arc<CertResolver>,
}

/// Configure TLS for the main endpoint.
pub fn configure_tls(
    key_path: &Path,
    cert_path: &Path,
    certs_dir: Option<&Path>,
    allow_tls_keylogfile: bool,
) -> anyhow::Result<TlsConfig> {
    // add default certificate
    let mut cert_resolver = CertResolver::parse_new(key_path, cert_path)?;

    // add extra certificates
    if let Some(certs_dir) = certs_dir {
        for entry in std::fs::read_dir(certs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                // file names aligned with default cert-manager names
                let key_path = path.join("tls.key");
                let cert_path = path.join("tls.crt");
                if key_path.exists() && cert_path.exists() {
                    cert_resolver.add_cert_path(&key_path, &cert_path)?;
                }
            }
        }
    }

    let common_names = cert_resolver.get_common_names();

    let cert_resolver = Arc::new(cert_resolver);

    // allow TLS 1.2 to be compatible with older client libraries
    let mut config =
        rustls::ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .context("ring should support TLS1.2 and TLS1.3")?
            .with_no_client_auth()
            .with_cert_resolver(cert_resolver.clone());

    config.alpn_protocols = vec![PG_ALPN_PROTOCOL.to_vec()];

    if allow_tls_keylogfile {
        // KeyLogFile will check for the SSLKEYLOGFILE environment variable.
        config.key_log = Arc::new(rustls::KeyLogFile::new());
    }

    let mut http_config = config.clone();
    let mut pg_config = config;

    http_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    pg_config.alpn_protocols = vec![b"postgresql".to_vec()];

    Ok(TlsConfig {
        http_config: Arc::new(http_config),
        pg_config: Arc::new(pg_config),
        common_names,
        cert_resolver,
    })
}

#[derive(Debug)]
pub struct CertResolver {
    certs: HashMap<String, (Arc<rustls::sign::CertifiedKey>, TlsServerEndPoint)>,
    default: (Arc<rustls::sign::CertifiedKey>, TlsServerEndPoint),
}

impl CertResolver {
    fn parse_new(key_path: &Path, cert_path: &Path) -> anyhow::Result<Self> {
        let (priv_key, cert_chain) = parse_key_cert(key_path, cert_path)?;
        Self::new(priv_key, cert_chain)
    }

    pub fn new(
        priv_key: PrivateKeyDer<'static>,
        cert_chain: Vec<CertificateDer<'static>>,
    ) -> anyhow::Result<Self> {
        let (domains, cert, tls_server_end_point) = process_key_cert(priv_key, cert_chain)?;

        let mut certs = HashMap::new();
        let default = (cert.clone(), tls_server_end_point);
        for domain in domains {
            certs.insert(domain, (cert.clone(), tls_server_end_point));
        }
        Ok(Self { certs, default })
    }

    fn add_cert_path(&mut self, key_path: &Path, cert_path: &Path) -> anyhow::Result<()> {
        let (priv_key, cert_chain) = parse_key_cert(key_path, cert_path)?;
        self.add_cert(priv_key, cert_chain)
    }

    fn add_cert(
        &mut self,
        priv_key: PrivateKeyDer<'static>,
        cert_chain: Vec<CertificateDer<'static>>,
    ) -> anyhow::Result<()> {
        let (domains, cert, tls_server_end_point) = process_key_cert(priv_key, cert_chain)?;
        for domain in domains {
            self.certs
                .insert(domain, (cert.clone(), tls_server_end_point));
        }
        Ok(())
    }

    pub fn get_common_names(&self) -> HashSet<String> {
        self.certs.keys().cloned().collect()
    }
}

fn parse_key_cert(
    key_path: &Path,
    cert_path: &Path,
) -> anyhow::Result<(PrivateKeyDer<'static>, Vec<CertificateDer<'static>>)> {
    let priv_key = {
        let key_bytes = std::fs::read(key_path)
            .with_context(|| format!("Failed to read TLS keys at '{}'", key_path.display()))?;
        rustls_pemfile::private_key(&mut &key_bytes[..])
            .with_context(|| format!("Failed to parse TLS keys at '{}'", key_path.display()))?
            .with_context(|| format!("Failed to parse TLS keys at '{}'", key_path.display()))?
    };

    let cert_chain_bytes = std::fs::read(cert_path).context(format!(
        "Failed to read TLS cert file at '{}.'",
        cert_path.display()
    ))?;

    let cert_chain = {
        rustls_pemfile::certs(&mut &cert_chain_bytes[..])
            .try_collect()
            .with_context(|| {
                format!(
                    "Failed to read TLS certificate chain from bytes from file at '{}'.",
                    cert_path.display()
                )
            })?
    };

    Ok((priv_key, cert_chain))
}

fn process_key_cert(
    priv_key: PrivateKeyDer<'static>,
    cert_chain: Vec<CertificateDer<'static>>,
) -> anyhow::Result<(Vec<String>, Arc<CertifiedKey>, TlsServerEndPoint)> {
    let key = sign::any_supported_type(&priv_key).context("invalid private key")?;

    let first_cert = &cert_chain[0];
    let tls_server_end_point = TlsServerEndPoint::new(first_cert)?;

    let certificate = SliceReader::new(first_cert)
        .context("Failed to parse cerficiate")?
        .decode::<x509_cert::Certificate>()
        .context("Failed to parse cerficiate")?;

    // Deployment certificates keep their routing identity in SAN. A generic CN
    // must not silently force SNI clients into the password-hack flow.
    let names: Vec<String> = if let Some((_, names)) = certificate
        .tbs_certificate
        .get::<x509_cert::ext::pkix::SubjectAltName>()
        .context("invalid certificate SAN")?
    {
        names
            .0
            .iter()
            .filter_map(|name| match name {
                x509_cert::ext::pkix::name::GeneralName::DnsName(name) => {
                    Some(name.as_str().to_owned())
                }
                _ => None,
            })
            .collect()
    } else {
        // Preserve older CN-only deployment certificates.
        vec![
            certificate
                .tbs_certificate
                .subject
                .to_string()
                .strip_prefix("CN=")
                .context("certificate has no routing name")?
                .to_owned(),
        ]
    };
    if names.is_empty() {
        bail!("certificate has no DNS routing name");
    }
    let domains = names
        .into_iter()
        .map(|name| {
            name.strip_prefix("*.")
                .or_else(|| name.strip_prefix("apiauth."))
                .unwrap_or(&name)
                .to_ascii_lowercase()
        })
        .collect();

    let cert = Arc::new(rustls::sign::CertifiedKey::new(cert_chain, key));

    Ok((domains, cert, tls_server_end_point))
}

impl rustls::server::ResolvesServerCert for CertResolver {
    fn resolve(
        &self,
        client_hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.resolve(client_hello.server_name()).0)
    }
}

impl CertResolver {
    pub fn resolve(
        &self,
        server_name: Option<&str>,
    ) -> (Arc<rustls::sign::CertifiedKey>, TlsServerEndPoint) {
        // loop here and cut off more and more subdomains until we find
        // a match to get a proper wildcard support. OTOH, we now do not
        // use nested domains, so keep this simple for now.
        //
        // With the current coding foo.com will match *.foo.com and that
        // repeats behavior of the old code.
        if let Some(mut sni_name) = server_name {
            loop {
                if let Some(cert) = self.certs.get(sni_name) {
                    return cert.clone();
                }
                if let Some((_, rest)) = sni_name.split_once('.') {
                    sni_name = rest;
                } else {
                    // The customer has some custom DNS mapping - just return
                    // a default certificate.
                    //
                    // This will error if the customer uses anything stronger
                    // than sslmode=require. That's a choice they can make.
                    return self.default.clone();
                }
            }
        } else {
            // No SNI, use the default certificate, otherwise we can't get to
            // options parameter which can be used to set endpoint name too.
            // That means that non-SNI flow will not work for CNAME domains in
            // verify-full mode.
            //
            // If that will be a problem we can:
            //
            // a) Instead of multi-cert approach use single cert with extra
            //    domains listed in Subject Alternative Name (SAN).
            // b) Deploy separate proxy instances for extra domains.
            self.default.clone()
        }
    }
}
