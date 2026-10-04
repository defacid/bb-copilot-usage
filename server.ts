import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const PROVIDER_ID = "github-copilot-usage";
const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const usageState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: z.null(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(z.object({
      kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
      id: z.string().min(1),
      label: z.string().min(1),
      usedPercent: z.number().nonnegative(),
      resetsAt: z.string().nullable(),
      model: z.string().nullable(),
      cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
    })),
  }),
  ...(["not_installed", "unauthenticated", "expired"] as const).map((status) => z.object({
    status: z.literal(status),
    plan: z.null(),
    accountEmail: z.null(),
    planLabel: z.null(),
  })),
  z.object({
    status: z.literal("error"),
    plan: z.null(),
    accountEmail: z.null(),
    planLabel: z.null(),
    message: z.string(),
  }),
]);

export const usageRpcContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({
      label: z.string().min(1).optional(),
      resources: z.array(z.object({
        accountKey: z.string().min(1).nullable(),
        id: z.string().min(1),
        providerId: z.string().min(1),
        label: z.string().min(1),
        scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
      })),
    }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({ accountKey: z.string().min(1).nullable(), observedAt: z.number().int().nonnegative().nullable(), usage: usageState }),
  },
});

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

  bb.rpc.register(usageRpcContract, {
    [LIST_RESOURCES]: async () => ({
      resources: (await bb.sdk.hosts.list())
        .filter((host) => host.status === "connected")
        .map((host) => ({
          accountKey: null,
          id: host.id,
          providerId: PROVIDER_ID,
          label: "GitHub Copilot",
          scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
        })),
    }),
    [GET_RESOURCE]: async ({ resourceId }) => {
      const state = (await bb.sdk.system.usageLimits({ hostId: resourceId }))[PROVIDER_ID];
      if (state === undefined) throw new Error("GitHub Copilot usage is unavailable on this host.");
      const base = { accountKey: null, observedAt: Date.now() };
      if (state.status === "ok") {
        return {
          ...base,
          usage: {
            status: "ok" as const,
            plan: null,
            accountEmail: state.accountEmail,
            planLabel: state.planLabel,
            windows: state.windows.map((window, index) => ({
              kind: "custom" as const,
              id: `copilot-${index}`,
              label: window.label,
              usedPercent: window.usedPercent,
              resetsAt: window.resetsAt,
              model: null,
              cost: window.cost ?? null,
            })),
          },
        };
      }
      if (state.status === "error") {
        return { ...base, usage: { status: "error" as const, plan: null, accountEmail: null, planLabel: null, message: state.message } };
      }
      return { ...base, usage: { status: state.status, plan: null, accountEmail: null, planLabel: null } };
    },
  }, {
    experimental_discoverable: true,
    experimental_description: "Publishes GitHub Copilot resources for BB's Provider Usage plugin.",
  });
}
