// Netlify supplies deployment metadata to the handler, not necessarily to env.
// Initialize it before importing the server, whose storage choices are cached.
export function createPortalRuntimeLoader(loadServer = () => import("../server.js")) {
  let server;
  let deployment;
  return async (context) => {
    const deploy = context?.deploy;
    if (!deploy?.context || !deploy?.id) throw new Error("Netlify deployment metadata is required.");
    const identity = `${deploy.context}:${deploy.id}`;
    if (deployment && deployment !== identity) throw new Error("Netlify deployment changed within the function runtime.");
    deployment = identity;
    if (!server) {
      process.env.OP_RUNTIME_NETLIFY = "true";
      process.env.OP_RUNTIME_CONTEXT = deploy.context;
      process.env.OP_RUNTIME_DEPLOY_ID = deploy.id;
      server = Promise.resolve().then(loadServer).catch((error) => { server = null; throw error; });
    }
    return server;
  };
}

export function portalRuntimeConfig(environment = process.env) {
  const netlify = environment.OP_RUNTIME_NETLIFY === "true";
  const productionDeploy = netlify && environment.OP_RUNTIME_CONTEXT === "production";
  return {
    netlify,
    productionDeploy,
    namespace: productionDeploy ? "production" : netlify ? environment.OP_RUNTIME_DEPLOY_ID : "local",
  };
}
