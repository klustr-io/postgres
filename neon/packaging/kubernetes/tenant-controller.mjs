// Namespace-scoped neon/controller/proxy deployment. Existing storage is a prerequisite;
// no database data, PVC or storage node is deleted by these permissions.
export function controllerResources({namespace,controllerImage,proxyImage}){
  for(const image of [controllerImage,proxyImage])if(!/@sha256:[a-f0-9]{64}$/.test(image))throw Error('Images must be digest-pinned');
  const metadata=name=>({name,namespace});
  const security={runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,seccompProfile:{type:'RuntimeDefault'}};
  const containerSecurity={allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}};
  const role={apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:metadata('neon-tenant-controller'),rules:[
    {apiGroups:[''],resources:['configmaps'],verbs:['get','list','patch']},
    {apiGroups:[''],resources:['secrets','services'],verbs:['get','create','patch']},
    {apiGroups:[''],resources:['pods'],verbs:['get','list']},
    {apiGroups:['apps'],resources:['deployments'],verbs:['get','create','patch']},
    {apiGroups:['coordination.k8s.io'],resources:['leases'],verbs:['get','create','patch']},
    {apiGroups:['discovery.k8s.io'],resources:['endpointslices'],verbs:['get','list']},
  ]};
  const controller={apiVersion:'apps/v1',kind:'Deployment',metadata:metadata('neon-tenant-controller'),spec:{replicas:1,
    strategy:{type:'Recreate'},selector:{matchLabels:{'app.kubernetes.io/name':'neon-tenant-controller'}},
    template:{metadata:{labels:{'app.kubernetes.io/name':'neon-tenant-controller'}},spec:{
      serviceAccountName:'neon-tenant-controller',securityContext:security,terminationGracePeriodSeconds:20,
      containers:[{name:'controller',image:controllerImage,imagePullPolicy:'IfNotPresent',
        env:[{name:'POD_NAMESPACE',valueFrom:{fieldRef:{fieldPath:'metadata.namespace'}}},
          {name:'POD_NAME',valueFrom:{fieldRef:{fieldPath:'metadata.name'}}}],
        ports:[{name:'api',containerPort:8080},{name:'health',containerPort:9090}],
        resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'512Mi'}},
        securityContext:containerSecurity,readinessProbe:{httpGet:{path:'/readyz',port:9090},periodSeconds:1},
        livenessProbe:{httpGet:{path:'/livez',port:9090},periodSeconds:10},
        volumeMounts:[{name:'tls',mountPath:'/run/controller-tls',readOnly:true},
          {name:'trust',mountPath:'/run/trust',readOnly:true},
          {name:'auth',mountPath:'/run/controller-auth',readOnly:true},{name:'tmp',mountPath:'/tmp'}]}],
      volumes:[{name:'tls',secret:{secretName:'neon-controller-tls',defaultMode:288}},
        {name:'trust',secret:{secretName:'neon-service-ca',defaultMode:292}},
        {name:'auth',secret:{secretName:'neon-controller-auth',defaultMode:288}},
        {name:'tmp',emptyDir:{sizeLimit:'64Mi'}}]}}}};
  const proxy={apiVersion:'apps/v1',kind:'Deployment',metadata:metadata('neon-proxy'),spec:{replicas:1,
    selector:{matchLabels:{'app.kubernetes.io/name':'neon-proxy'}},
    template:{metadata:{labels:{'app.kubernetes.io/name':'neon-proxy'}},spec:{automountServiceAccountToken:false,
      securityContext:security,terminationGracePeriodSeconds:60,
      containers:[{name:'proxy',image:proxyImage,imagePullPolicy:'IfNotPresent',
        args:['--proxy','0.0.0.0:5432','--auth-backend','control-plane','--auth-endpoint',
          `https://neon-controller.${namespace}.svc.cluster.local:8080/`,'--http','0.0.0.0:7001',
          '--tls-key','/run/proxy-tls/tls.key','--tls-cert','/run/proxy-tls/tls.crt',
          '--wake-compute-cache','size=0'],
        env:[{name:'NEON_PROXY_TO_CONTROLPLANE_TOKEN',valueFrom:{secretKeyRef:{name:'neon-controller-auth',key:'token'}}},
          {name:'SSL_CERT_FILE',value:'/run/trust/ca.crt'},{name:'OTEL_SDK_DISABLED',value:'true'}],
        ports:[{name:'postgres',containerPort:5432},{name:'metrics',containerPort:7001}],
        resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'2',memory:'512Mi'}},
        securityContext:containerSecurity,readinessProbe:{httpGet:{path:'/v1/status',port:7001},periodSeconds:1},
        volumeMounts:[{name:'tls',mountPath:'/run/proxy-tls',readOnly:true},{name:'ca',mountPath:'/run/trust',readOnly:true},
          {name:'tmp',mountPath:'/tmp'}]}],
      volumes:[{name:'tls',secret:{secretName:'neon-proxy-tls',defaultMode:288}},
        {name:'ca',secret:{secretName:'neon-service-ca',defaultMode:292}},{name:'tmp',emptyDir:{sizeLimit:'128Mi'}}]}}}};
  const service=(name,selector,port)=>({apiVersion:'v1',kind:'Service',metadata:metadata(name),spec:{
    type:'ClusterIP',selector:{'app.kubernetes.io/name':selector},ports:[{port,targetPort:port}]}});
  return [
    {apiVersion:'v1',kind:'ServiceAccount',metadata:metadata('neon-tenant-controller')},role,
    {apiVersion:'rbac.authorization.k8s.io/v1',kind:'RoleBinding',metadata:metadata('neon-tenant-controller'),
      roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:'neon-tenant-controller'},
      subjects:[{kind:'ServiceAccount',name:'neon-tenant-controller',namespace}]},
    controller,proxy,service('neon-controller','neon-tenant-controller',8080),service('neon-proxy','neon-proxy',5432),
    {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:metadata('neon-controller-ingress'),spec:{
      podSelector:{matchLabels:{'app.kubernetes.io/name':'neon-tenant-controller'}},policyTypes:['Ingress'],
      ingress:[{from:['neon-proxy','neon-compute'].map(name=>({podSelector:{matchLabels:{'app.kubernetes.io/name':name}}})),ports:[{protocol:'TCP',port:8080}]}]}},
    {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:metadata('neon-compute-ingress'),spec:{
      podSelector:{matchLabels:{'app.kubernetes.io/name':'neon-compute'}},policyTypes:['Ingress'],
      ingress:[{from:['neon-proxy','neon-tenant-controller'].map(name=>({podSelector:{matchLabels:{'app.kubernetes.io/name':name}}})),
        ports:[{protocol:'TCP',port:5432}]}]}},
    {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:metadata('neon-proxy-ingress'),spec:{
      podSelector:{matchLabels:{'app.kubernetes.io/name':'neon-proxy'}},policyTypes:['Ingress'],ingress:[{ports:[{protocol:'TCP',port:5432}]}]}},
  ];
}
