/**
 * `@zalkera/devtools-core` — 로컬 레일의 러너.
 *
 * 확장도 CLI 도 여기만 부른다. 어느 길로 오든 동작이 같아야 하므로 **로직은 전부 여기 산다**(확장은
 * 얇은 껍데기여야 CLI·데스크톱이 같은 것을 재사용한다).
 */
export { DevtoolsError, type DevtoolsErrorCode } from "./errors.ts";
export { fetchHandshake, type Handshake } from "./handshake.ts";
export { createPkce, createState, type Pkce } from "./auth/pkce.ts";
export {
  startLoopbackReceiver,
  type LoopbackReceiver,
} from "./auth/loopback.ts";
export {
  getAccessToken,
  login,
  logout,
  type AuthConfig,
  type LoginOptions,
} from "./auth/oauth.ts";
export {
  MemoryTokenStore,
  type StoredTokens,
  type TokenStore,
} from "./auth/store.ts";
export {
  ZalkeraApi,
  needsDiscardConsent,
  reflectionOf,
  type ReflectionState,
  switchCandidates,
  type ActivateResult,
  type DraftState,
  isDraftInProgress,
  revisionWhen,
  type ApiOptions,
  type IssuedPreviewKey,
  type PresetSource,
  type PresignedUpload,
  type RevisionSource,
  type SitePreset,
  type SiteRevision,
  type TenantSummary,
} from "./api.ts";
export {
  MANAGED_KEYS,
  mergeEnv,
  stripCredentials,
  writePreviewEnv,
  type PreviewEnv,
} from "./env.ts";
export {
  ensureEnvIgnored,
  inspectProject,
  type ProjectInfo,
} from "./project.ts";
export {
  computeCacheKey,
  ensureDependencies,
  type DepsOptions,
  type DepsResult,
} from "./deps.ts";
export {
  computePayloadKey,
  currentPlatform,
  evictOldCaches,
  tryFetchPayload,
  type PayloadOptions,
  type PayloadResult,
} from "./payload.ts";
export { extractTarGz, extractTarGzFile, type UntarOptions } from "./untar.ts";
export {
  pickPort,
  startDevServer,
  translateLog,
  type DevServer,
  type DevServerOptions,
} from "./dev.ts";
export {
  createZip,
  isExcludedEntry,
  packProject,
  writeZip,
  type PackResult,
  type ZipEntry,
} from "./zip.ts";
export { publish, type PublishOptions, type PublishResult } from "./publish.ts";
export {
  startPreview,
  type PreviewOptions,
  type PreviewSession,
} from "./preview.ts";
export { runDoctor, type DoctorCheck, type DoctorOptions } from "./doctor.ts";
export {
  downloadSourceZip,
  fetchSiteSource,
  fetchVerifiedSourceTar,
  findProjectRoot,
  type FetchSourceOptions,
  type FetchSourceResult,
  type SourceZipResult,
  type VerifiedSourceTar,
} from "./fetchSource.ts";
export { extractZip, listZipEntries, type UnzipResult } from "./unzip.ts";
export { decideImportPlan, readZipFile, type ImportPlan } from "./importZip.ts";
export { keepNames, replaceContents, type ReplaceResult } from "./replaceDir.ts";
export {
  PROVENANCE_PATH,
  buildProvenance,
  judgeUpdate,
  parseProvenance,
  type Provenance,
  type UpdateVerdict,
} from "./provenance.ts";
export { isReceivable, meaningfulEntries, removeAdded, snapshotEntries } from "./emptyDir.ts";

export { waitForBuild, type BuildOutcome, type WaitOptions } from "./build.ts";

export { captureTenant, resolveHelpUrl } from "./tenantScope.ts";
export {
  httpUrl,
  isLoopback,
  apiBaseUrl,
  mcpServerName,
  type McpServerName,
} from "./serverUrl.ts";
export { safeFileName, writeOwnFile, ensureOwnDir } from "./safeWrite.ts";
export {
  chooseNpm,
  describeNpm,
  npmArgvOf,
  acceptsResolvedNpmCli,
  systemNpmSearchSteps,
  type NpmSearchStep,
  type PathOps,
  majorOf,
  MIN_SYSTEM_NPM_MAJOR,
  type NpmChoice,
  type NpmPreference,
  type NpmProbe,
} from "./npmChoice.ts";
export {
  isUsableVersion,
  shouldShowUpgradeNotice,
  UPGRADE_NOTICE_INTERVAL_MS,
  type UpgradeNoticeState,
} from "./upgradeNotice.ts";
export { plainNotice, ours, count, countJosa } from "./notice.ts";
export { say, type CapturedTenant } from "./tenantScope.ts";
export { fetchPresetZip, type PresetZip } from "./presets.ts";
export {
  precheck,
  type PrecheckFinding,
  type PrecheckOptions,
} from "./precheck.ts";
export {
  registerMcpServer,
  type McpRegistration,
  type RegisterMcpResult,
} from "./mcp.ts";
export { ensureAgentDocs, type AgentDocsResult } from "./agents.ts";
export {
  diagnose,
  diagnoseClientUsage,
  protectedPathKind,
  protectedPathWarning,
  type ProtectedKind,
  type Diagnostic,
} from "./diagnostics.ts";
export { BUSY, createReentrancyGuard } from "./reentrancy.ts";
export {
  pickRevision,
  noRevisionError,
  suggestFolderName,
  nextAvailableName,
  decideFetchedInto,
  type FetchedIntoPlan,
} from "./fetchTarget.ts";
export { decideErrorNotice, isCancelled, type ErrorNotice } from "./errorNotice.ts";
export { decideBlocked, commandsWithNeeds, type Blocked, type Readiness } from "./whyBlocked.ts";
export { ACCOUNT_SCOPED, type AccountScoped } from "./accountState.ts";
export {
  MAX_ISSUED_KEYS,
  addIssuedKey,
  addIssuedKeyWithOverflow,
  readIssuedKeys,
  readIssuedKeysWithOverflow,
  removeIssuedKey,
  type IssuedKey,
} from "./issuedKeys.ts";
export type { RevisionChoice, RevisionLike } from "./fetchTarget.ts";
export {
    buildSourceMark,
    parseSourceMark,
    holdsSameRevision,
    declaredBaseRevisionNo,
    mergeTenantSetting,
    SOURCE_MARK_PATH,
    writeSourceMarkTo,
    writeBindingMarkTo,
    linkFolderToTenant,
} from "./localMark.ts";
export type { SourceMark } from "./localMark.ts";
export {
    folderBinding,
    linkedTenantOf,
    decideImportBinding,
    decideTenantScope,
    decideSiteChoice,
    elsewhereOptions,
    decidePickedFolder,
    decideFetchTargetPlan,
    changeFolderPlan,
    needsRelinkConsent,
    type TenantScope,
    type SiteChoice,
    type ElsewhereOption,
    type PickedFolderPlan,
    type FetchTargetPlan,
    type ChangeFolderPlan,
    type WorkspaceLink,
    type ImportBinding,
} from "./siteBinding.ts";
export { sidebarPlan } from "./sidebarPlan.ts";
export { displayPath } from "./displayPath.ts";
export { idleStatusPlan, type StatusPlan } from "./statusPlan.ts";
export type { PlanGroup, PlanItem, SidebarState } from "./sidebarPlan.ts";
