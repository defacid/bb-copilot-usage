import { type BbPluginApi } from "@get-bb/plugin-sdk";

const PROVIDER_ID = "github-copilot-usage";

export default function plugin(bb: BbPluginApi): void {
  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "GitHub Copilot",
    icon: "Github",
    family: "github-copilot",
    strings: {
      signInHint: "Run `copilot login` on this machine, then reload usage.",
      expiredHint: "Run `copilot login` on this machine, then reload usage.",
      installUrl: "https://github.com/features/copilot/cli",
    },
    maintenance: { health: false, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
    models: { fallback: [], scope: "host" },
    composerActions: [],
  });
}
