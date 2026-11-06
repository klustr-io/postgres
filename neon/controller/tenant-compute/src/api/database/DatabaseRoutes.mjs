/**
 * Declare database routes without lifecycle, storage or branching decisions.
 * @param {import('./DatabaseController.mjs').DatabaseController} database - Database HTTP adapter.
 * @param {import('../recovery/RecoveryController.mjs').RecoveryController} recovery - Recovery HTTP adapter.
 * @param {import('./BranchController.mjs').BranchController} branch - Branch HTTP adapter.
 * @returns {import('../http/ControlPlaneRouter.mjs').ControlPlaneRoute[]} Named-resource route registry.
 */
export function DatabaseRoutes(database, recovery, branch) {
  const routes = [
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})$/, methods: {GET: database.Get.bind(database), PUT: database.Put.bind(database), DELETE: database.Delete.bind(database)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/events$/, methods: {POST: database.Event.bind(database)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/suspend$/, methods: {POST: database.Suspend.bind(database)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/resume$/, methods: {POST: database.Resume.bind(database)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/branches$/, methods: {POST: branch.Create.bind(branch)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/history$/, methods: {GET: recovery.History.bind(recovery)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/backups$/, methods: {GET: recovery.List.bind(recovery), POST: recovery.Create.bind(recovery)}},
    {pattern: /^\/v1\/backups\/(?<name>[a-z][a-z0-9-]{0,38})$/, methods: {GET: recovery.Get.bind(recovery), DELETE: recovery.Delete.bind(recovery)}}
  ];
  return routes.map(route => ({...route, authentication: 'management'}));
}
