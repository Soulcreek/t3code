import {
  AcpSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { buildAcpModelCapabilities, extractModelOptions } from "../acp/AcpRuntimeModel.ts";
import { ProviderDriverError } from "../Errors.ts";
import { type AcpAdapterProfile, makeAcpAdapter } from "../Layers/CursorAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("acp");
const decodeSettings = Schema.decodeSync(AcpSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const defaultModels = (capabilities: ModelCapabilities = EMPTY_CAPABILITIES) => [
  {
    slug: "agent-default",
    name: "Agent default",
    isCustom: false,
    capabilities,
  },
];

function missingCommandMessage(command: string): string {
  return command ? `${command} is not installed or not on PATH.` : "Configure an ACP CLI command.";
}
export type AcpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const AcpDriver: ProviderDriver<AcpSettings, AcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ACP Agent", supportsMultipleInstances: true },
  configSchema: AcpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const driverScope = yield* Scope.Scope;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const observedConfigRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(
        [],
      );
      const agentName = displayName?.trim() || path.basename(config.binaryPath) || "ACP Agent";
      const makeRuntime: AcpAdapterProfile["makeRuntime"] = ({
        childProcessSpawner,
        environment: runtimeEnvironment,
        ...input
      }) =>
        AcpSessionRuntime.make({
          ...input,
          spawn: {
            command: config.binaryPath,
            args: tokenizeCliArgs(config.launchArgs),
            cwd: input.cwd,
            ...(runtimeEnvironment ? { env: runtimeEnvironment } : {}),
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        );
      const makeSnapshot = (input: {
        readonly checkedAt: string;
        readonly installed: boolean;
        readonly status: "ready" | "warning" | "error";
        readonly message: string;
        readonly displayName?: string;
        readonly version?: string | null;
        readonly models?: ReadonlyArray<ServerProviderModel>;
      }) => ({
        ...buildServerProvider({
          presentation: { displayName: displayName?.trim() || input.displayName || agentName },
          enabled,
          checkedAt: input.checkedAt,
          models: providerModelsFromSettings(
            input.models ?? defaultModels(),
            config.customModels,
            EMPTY_CAPABILITIES,
          ),
          probe: {
            installed: input.installed,
            version: input.version ?? null,
            status: input.status,
            auth: { status: "unknown" },
            message: input.message,
          },
        }),
        instanceId,
        driver: DRIVER_KIND,
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const unavailableSnapshot = (
        checkedAt: string,
        message: string,
        installed = false,
        status: "warning" | "error" = installed ? "warning" : "error",
      ) => makeSnapshot({ checkedAt, installed, status, message });
      const initialSnapshot = () =>
        Effect.map(DateTime.now, (now) =>
          unavailableSnapshot(
            DateTime.formatIso(now),
            config.binaryPath ? "Discovering ACP models..." : missingCommandMessage(""),
            config.binaryPath.length > 0,
          ),
        );
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!enabled) {
          return unavailableSnapshot(
            checkedAt,
            "ACP agent is disabled in T3 Code settings.",
            false,
            "warning",
          );
        }
        const installed =
          config.binaryPath.length > 0 &&
          (yield* isCommandAvailable(config.binaryPath, { env: processEnv }));
        if (!installed) {
          return unavailableSnapshot(checkedAt, missingCommandMessage(config.binaryPath));
        }

        const connected = yield* makeRuntime({
          childProcessSpawner: spawner,
          environment: processEnv,
          cwd: serverConfig.cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.flatMap((runtime) => runtime.initialize()),
          Effect.scoped,
          Effect.timeout("10 seconds"),
          Effect.result,
        );
        if (Result.isFailure(connected)) {
          const failure = connected.failure;
          const authRequired = failure._tag === "AcpRequestError" && failure.code === -32000;
          return unavailableSnapshot(
            checkedAt,
            authRequired
              ? "Authentication required. Sign in with the configured CLI outside T3 Code, then retry."
              : "The ACP process started, but its initialize handshake failed.",
            true,
          );
        }

        const agentInfo = connected.success.agentInfo;
        const observedOptions = yield* Ref.get(observedConfigRef);
        const modelCapabilities = buildAcpModelCapabilities(observedOptions);
        const models = extractModelOptions(observedOptions).map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.isDefault ? { isDefault: true } : {}),
          capabilities: modelCapabilities,
        }));
        const discoveredDisplayName = agentInfo?.title?.trim() || agentInfo?.name.trim();
        return makeSnapshot({
          checkedAt,
          installed: true,
          status: "ready",
          message:
            models.length > 0
              ? `${models.length} ACP models discovered.`
              : "ACP handshake succeeded. Models are discovered from the first active session.",
          ...(discoveredDisplayName ? { displayName: discoveredDisplayName } : {}),
          version: agentInfo?.version.trim() || null,
          models: [...defaultModels(modelCapabilities), ...models],
        });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const snapshot = yield* makeManagedServerProvider<AcpSettings>({
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSettings: Effect.succeed(config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot,
        checkProvider,
        refreshOnInterval: false,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const onConfigOptionsChanged = (
        options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      ) =>
        Ref.set(observedConfigRef, options).pipe(
          Effect.andThen(
            snapshot.refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to refresh ACP model metadata.", { cause }),
              ),
              Effect.forkIn(driverScope),
              Effect.asVoid,
            ),
          ),
        );
      const adapter = yield* makeAcpAdapter(
        {
          provider: DRIVER_KIND,
          displayName: agentName,
          modelSelection: "standard",
          onConfigOptionsChanged,
          makeRuntime,
        },
        { environment: processEnv, instanceId },
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(agentName),
      };
    }),
};
