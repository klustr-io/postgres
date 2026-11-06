/**
 * Bind the fixed upstream proxy protocol routes to named controller operations.
 * @param {import('./ProxyController.mjs').ProxyController} controller - Proxy HTTP adapter.
 * @returns {import('../http/ControlPlaneRouter.mjs').ControlPlaneRoute[]} Proxy-authenticated route registry.
 */
export function ProxyRoutes(controller) {
  return [
    {pattern: /^\/get_endpoint_access_control$/, query: true, authentication: 'proxy', methods: {GET: controller.AccessControl.bind(controller)}},
    {pattern: /^\/wake_compute$/, query: true, authentication: 'proxy', methods: {GET: controller.Wake.bind(controller)}},
    {pattern: /^\/endpoints\/(?<name>[^/]+)\/jwks$/, query: true, authentication: 'proxy', methods: {GET: controller.Jwks.bind(controller)}}
  ];
}
