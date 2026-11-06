/**
 * Bind fleet routes to named controller operations without implementing commands.
 * @param {import('./FleetController.mjs').FleetController} controller - Fleet transport adapter.
 * @returns {import('../http/ControlPlaneRouter.mjs').ControlPlaneRoute[]} Declarative method/path bindings.
 */
export function FleetRoutes(controller) {
  return [{pattern: /^\/v1\/fleet$/, authentication: 'management', methods: {GET: controller.Get.bind(controller), PUT: controller.Revise.bind(controller)}}];
}
