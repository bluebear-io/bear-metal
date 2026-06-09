import { config } from "dotenv";
config({ path: ".env.local" });

import { GitHubIntegration, LinearIntegration } from "./src/shared/index.js";
import { dispatch } from "./src/worker/dispatch.js";
import { loadConfig } from "./src/manager/config.js";

const managerConfig = loadConfig();

const result = await dispatch({
  state: "new",
  ticketId: "DEN-2281",
  integrations: {
    github: new GitHubIntegration({
      appId: managerConfig.githubAppId,
      privateKey: managerConfig.githubAppPrivateKey,
      installationId: managerConfig.githubAppInstallationId,
    }),
    linear: new LinearIntegration({ token: managerConfig.linearApiToken }),
  },
  force: true,
});

console.log("dispatch result:", result);
