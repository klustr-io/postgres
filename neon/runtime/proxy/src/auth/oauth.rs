//! Native RFC 7628 PostgreSQL authentication. No credential substitution or password fallback.
use super::backend::{ComputeCredentialKeys, ComputeCredentials, ComputeUserInfo};
use super::{AuthError, Result};
use crate::context::RequestContext;
use crate::control_plane::{ControlPlaneApi, OAuthConfig};
use crate::pqproto::{BeAuthenticationSaslMessage as Sasl, BeMessage};
use crate::stream::{PqStream, Stream};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

fn bearer(message: &str) -> Option<&str> {
    let fields = message
        .strip_prefix("n,,\x01")
        .or_else(|| message.strip_prefix("y,,\x01"))?
        .strip_suffix("\x01\x01")?;
    let mut token = None;
    for field in fields.split('\x01') {
        let (key, value) = field.split_once('=')?;
        if key == "auth" {
            if token.is_some() {
                return None;
            }
            let value = if value.is_empty() {
                ""
            } else {
                value.strip_prefix("Bearer ")?
            };
            let content = value.trim_end_matches('=');
            if !content
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~+/".contains(&b))
            {
                return None;
            }
            token = Some(value);
        } else if key != "host" && key != "port" {
            return None;
        }
    }
    token
}

pub(super) async fn authenticate(
    ctx: &RequestContext,
    api: &impl ControlPlaneApi,
    info: ComputeUserInfo,
    client: &mut PqStream<Stream<impl AsyncRead + AsyncWrite + Unpin>>,
    policy: &OAuthConfig,
    timeout: Duration,
) -> Result<ComputeCredentials> {
    if !matches!(client.get_ref(), Stream::Tls { .. }) {
        return Err(AuthError::bad_auth_method("OAUTHBEARER requires TLS"));
    }
    let bytes = tokio::time::timeout(timeout, async {
        client.write_message(BeMessage::AuthenticationSasl(Sasl::Methods(&[
            "OAUTHBEARER",
        ])));
        client.flush().await?;
        Ok::<_, std::io::Error>(client.read_oauth_message().await?.to_vec())
    })
    .await
    .map_err(AuthError::user_timeout)??;
    if bytes.len() > 13312 {
        return Err(AuthError::bad_auth_method("invalid OAuth message"));
    }
    let first = crate::sasl::FirstMessage::parse(&bytes)
        .ok_or(AuthError::bad_auth_method("invalid OAuth message"))?;
    if first.method != "OAUTHBEARER" {
        return Err(AuthError::bad_auth_method("OAUTHBEARER required"));
    }
    let token = bearer(first.message)
        .ok_or(AuthError::bad_auth_method("invalid OAuth message"))?
        .to_owned();
    if token.len() > 12288 {
        return Err(AuthError::bad_auth_method("invalid OAuth token"));
    }
    let authorized = !token.is_empty()
        && tokio::time::timeout(
            Duration::from_secs(110),
            api.authorize_oauth(ctx, &info.endpoint, &info.user, &token),
        )
        .await
        .is_ok_and(|result| result.is_ok());
    if !authorized {
        let discovery = if policy.issuer.contains("/.well-known/") {
            policy.issuer.clone()
        } else {
            format!(
                "{}/.well-known/openid-configuration",
                policy.issuer.trim_end_matches('/')
            )
        };
        let challenge = serde_json::to_vec(&serde_json::json!({"status":"invalid_token",
                "scope":policy.scope,"openid-configuration":discovery}))
        .map_err(|_| AuthError::bad_auth_method("OAuth discovery unavailable"))?;
        client.write_message(BeMessage::AuthenticationSasl(Sasl::Continue(&challenge)));
        client.flush().await?;
        let ack = tokio::time::timeout(timeout, client.read_password_message())
            .await
            .map_err(AuthError::user_timeout)??;
        if ack != b"\x01" {
            return Err(AuthError::bad_auth_method("invalid OAuth acknowledgment"));
        }
        return Err(AuthError::password_failed(info.user.as_str()));
    }
    ctx.set_auth_method(crate::context::AuthMethod::OAuthBearer);
    client.write_message(BeMessage::AuthenticationOk);
    Ok(ComputeCredentials {
        info,
        keys: ComputeCredentialKeys::OAuthBearer(token.into_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::bearer;
    #[test]
    fn native_bearer_parser() {
        assert_eq!(
            bearer("n,,\x01auth=Bearer abc.def-123\x01\x01"),
            Some("abc.def-123")
        );
        assert_eq!(bearer("n,,\x01auth=Bearer \x01\x01"), Some(""));
        assert_eq!(bearer("n,,\x01auth=\x01\x01"), Some(""));
        assert_eq!(
            bearer("n,,\x01host=db\x01port=5432\x01auth=Bearer abc==\x01\x01"),
            Some("abc==")
        );
        for invalid in [
            "n,a=admin,\x01auth=Bearer abc\x01\x01",
            "n,,\x01auth=Bearer abc def\x01\x01",
            "n,,\x01auth=Bearer a\x01auth=Bearer b\x01\x01",
            "n,,\x01auth=Basic abc\x01\x01",
        ] {
            assert_eq!(bearer(invalid), None);
        }
    }
}
