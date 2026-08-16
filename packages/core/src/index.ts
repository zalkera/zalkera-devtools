/**
 * `@zalkera/devtools-core` — 로컬 레일의 러너.
 *
 * 확장도 CLI 도 여기만 부른다. 어느 길로 오든 동작이 같아야 하므로 **로직은 전부 여기 산다**(확장은
 * 얇은 껍데기여야 CLI·데스크톱이 같은 것을 재사용한다).
 */
export { DevtoolsError, type DevtoolsErrorCode } from "./errors.ts";
export { fetchHandshake, type Handshake } from "./handshake.ts";
export { createPkce, createState, type Pkce } from "./auth/pkce.ts";
export { startLoopbackReceiver, type LoopbackReceiver } from "./auth/loopback.ts";
export { getAccessToken, login, logout, type AuthConfig, type LoginOptions } from "./auth/oauth.ts";
export { MemoryTokenStore, type StoredTokens, type TokenStore } from "./auth/store.ts";
export {
    ZalkeraApi,
    type ApiOptions,
    type IssuedPreviewKey,
    type PresetSource,
    type PresignedUpload,
    type RevisionSource,
    type SitePreset,
    type SiteRevision,
    type TenantSummary,
} from "./api.ts";
export { MANAGED_KEYS, mergeEnv, stripCredentials, writePreviewEnv, type PreviewEnv } from "./env.ts";
export { ensureEnvIgnored, inspectProject, type ProjectInfo } from "./project.ts";
export { computeCacheKey, ensureDependencies, type DepsOptions, type DepsResult } from "./deps.ts";
export {
    computePayloadKey,
    currentPlatform,
    evictOldCaches,
    tryFetchPayload,
    type PayloadOptions,
    type PayloadResult,
} from "./payload.ts";
export { extractTarGz, extractTarGzFile, type UntarOptions } from "./untar.ts";
export { pickPort, startDevServer, translateLog, type DevServer, type DevServerOptions } from "./dev.ts";
export { createZip, packProject, writeZip, type PackResult, type ZipEntry } from "./zip.ts";
export { publish, type PublishOptions, type PublishResult } from "./publish.ts";
export { startPreview, type PreviewOptions, type PreviewSession } from "./preview.ts";
export { runDoctor, type DoctorCheck, type DoctorOptions } from "./doctor.ts";
export {
    fetchSiteSource,
    findProjectRoot,
    type FetchSourceOptions,
    type FetchSourceResult,
} from "./fetchSource.ts";
export { extractZip, type UnzipResult } from "./unzip.ts";
export { isReceivable, meaningfulEntries } from "./emptyDir.ts";

export { waitForBuild, type BuildOutcome, type WaitOptions } from "./build.ts";

export {
    captureTenant,
    decideReadyPrompt,
    decideSwitch,
    resolveHelpUrl,
} from "./tenantScope.ts";
export { httpUrl, isLoopback, apiBaseUrl, mcpServerName } from "./serverUrl.ts";
export {
    say,
    type CapturedTenant,
    type ReadyPrompt,
    type SwitchDecision,
} from "./tenantScope.ts";
export { startFromPreset, type StartFromPresetOptions, type StartFromPresetResult } from "./presets.ts";
export { precheck, type PrecheckFinding, type PrecheckOptions } from "./precheck.ts";
export { registerMcpServer, type McpRegistration, type RegisterMcpResult } from "./mcp.ts";
export { ensureAgentDocs, type AgentDocsResult } from "./agents.ts";
export {
    diagnose,
    diagnoseClientUsage,
    protectedPathWarning,
    type Diagnostic,
} from "./diagnostics.ts";
