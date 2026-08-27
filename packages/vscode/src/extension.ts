import * as vscode from "vscode";
import {
  DevtoolsError,
  diagnose,
  diagnoseClientUsage,
  ensureAgentDocs,
  fetchHandshake,
  fetchSiteSource,
  findProjectRoot,
  getAccessToken,
  login,
  logout,
  precheck,
  protectedPathKind,
  protectedPathWarning,
  type ProtectedKind,
  publish,
  registerMcpServer,
  runDoctor,
  downloadSourceZip,
  fetchPresetZip,
  safeFileName,
  startPreview,
  stripCredentials,
  ZalkeraApi,
  waitForBuild,
  captureTenant,
  type CapturedTenant,
  ours,
  plainNotice,
  count,
  countJosa,
  resolveHelpUrl,
  type NpmPreference,
  shouldShowUpgradeNotice,
  type UpgradeNoticeState,
  writeOwnFile,
  httpUrl,
  apiBaseUrl,
  mcpServerName,
  say,
  type DevServer,
  type FetchSourceResult,
  type Handshake,
  type PreviewSession,
  type PublishResult,
  BUSY,
  createReentrancyGuard,
  pickRevision,
  stashLeftovers,
  refreshSiteSource,
  decideErrorNotice,
  decideBlocked,
  idleStatusPlan,
  packProject,
  decideImportPlan,
  type ImportPlan,
  extractZip,
  listZipEntries,
  meaningfulEntries,
  PROVENANCE_PATH,
  judgeUpdate,
  keepNames,
  parseProvenance,
  replaceContents,
  type UpdateVerdict,
  removeAdded,
  snapshotEntries,
  readZipFile,
  folderBinding,
  changeFolderPlan,
  linkedTenantOf,
  decideImportBinding,
  type WorkspaceLink,
  type ImportBinding,
  decideTenantScope,
  type TenantScope,
  decideSiteChoice,
  decideFetchTargetPlan,
  decideFetchedInto,
  decidePickedFolder,
  elsewhereOptions,
  isReceivable,
  type ElsewhereOption,
  needsRelinkConsent,
  folderStillShown,
  writeBindingMarkTo,
  isCancelled,
  readIssuedKeysWithOverflow,
  addIssuedKeyWithOverflow,
  addIssuedKey,
  removeIssuedKey,
  type IssuedKey,
  noRevisionError,
  needsDiscardConsent,
  switchCandidates,
  type ActivateResult,
  isDraftInProgress,
  revisionWhen,
  suggestFolderName,
  nextAvailableName,
  writeSourceMarkTo,
  linkFolderToTenant,
  parseSourceMark,
  holdsSameRevision,
  declaredBaseRevisionNo,
  reflectionOf,
  type ReflectionState,
  SOURCE_MARK_PATH,
  type SourceMark,
} from "@zalkera/devtools-core";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SecretTokenStore } from "./secretStore.ts";
import {
  describeNpm,
  embeddedNodeRuntime,
  npmArgvOf,
  resolveNpm,
} from "./runtime.ts";
import { ZalkeraSidebar } from "./sidebar.ts";

/**
 * 잘커라 확장(T3 MVP · memo146 §5).
 *
 * **확장이 하는 일은 넷뿐이다**: 런타임 배달 · 자격증명 배달 · MCP 등록 대행(T4) · 프로세스 관리.
 * 로직은 전부 `@zalkera/devtools-core` 에 있고 이 파일은 **얇은 껍데기**다 — 두꺼워지면 CLI·데스크톱이
 * 같은 것을 재사용하지 못한다(§W-5).
 *
 * 표면도 넷뿐이다: 상태바 1칸 · 출력 채널 1 · 명령 팔레트 · (T5) 사이드바.
 */

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
/**
 * 도는 미리보기. **`tenant` 를 함께 든다** — 자동 갱신 재기동이 「그 시점의」 선택을 다시 읽으면,
 * 사이드바에서 사이트를 바꿔 둔 사이에 미리보기가 **말없이 다른 사이트로** 다시 선다(심의 지적).
 */
let session: {
  server: DevServer;
  projectDir: string;
  keyId: number;
  tenant: CapturedTenant;
} | null = null;
/** 미리보기 시작 재진입 가드 — 첫 실행은 수 분짜리 설치라 사용자가 반드시 두 번 누른다(심의 경고). */
const previewGuard = createReentrancyGuard();
/**
 * **소스 받기 재진입 가드.** 판정은 `createReentrancyGuard`(core)가 하고 여기서는 **문면만** 정한다 —
 * 확장 안에 판정을 두면 시험도 검사기도 못 닿는다(실측: 조건을 무력화해도 297건 전부 초록이었다).
 *
 * 「소스 다운로드」·「zip 으로 시작」·「zip 으로 교체」가 **같은 가드**를 쓴다 — 셋 다 폴더에
 * 아카이브를 푸는 일이라 어느 조합이든 겹치면 안 된다. 겹쳤을 때 나는 일은 core 쪽 KDoc 에 있다.
 *
 * 취소 단추는 별건이다: `fetchSiteSource`·`fetchPresetZip` 이 아직 취소 신호를 안 받으므로,
 * 단추만 달면 눌러도 아무 일이 없는 **거짓 단추**가 된다.
 */
const receiveGuard = createReentrancyGuard();

/**
 * **푸는 동안만** 가드를 들고 `run` 을 돌린다. 이미 누가 풀고 있으면 [BUSY] — 부르는 쪽이 손을 뗀다.
 *
 * ⚠ **사람에게 묻는 자리를 덮지 않는다.** 종전에는 명령 진입점에서 가드를 잡아 로그인·사이트
 *   선택·받을 폴더 고르기·완료 알림까지 통째로 덮었다. 그런데 VS Code 알림은 **단추가 달리면
 *   저절로 사라지지 않고** 파일 대화상자는 창 뒤에 남는다 — 답하지 않은 물음 하나가 프라미스를
 *   영영 붙들어 `finally` 가 돌지 못했다. 그러면 **실수로 누른 「소스 다운로드」 하나가** 창을 새로
 *   열 때까지 「zip 으로 시작」·「zip 으로 교체」를 막았다(실사용 신고). 탈출구도 없다 — 받기에는
 *   취소 단추가 없고 「초기화」도 이 가드를 안 푼다.
 *
 * 잡는 자리를 **아카이브를 실제로 푸는 구간 하나**로 둔다. 그것이 이 가드가 막으려는 위험의
 * 전부이기도 하다(`reentrancy.ts`). 그 구간은 진행 알림이 내내 떠 있고 상한도 있어(전송 15분),
 * 그때만 「푸는 중」이 참이다.
 */
async function whileExtracting<T>(run: () => Thenable<T>): Promise<T | typeof BUSY> {
  // `withProgress` 가 주는 것은 `Thenable` 이라 그대로는 core 의 계약(`Promise`)에 안 맞는다.
  // **감싸는 자리는 여기 하나다** — 부르는 셋이 각자 감싸면 한쪽만 고쳐진다.
  const outcome = await receiveGuard.run(async () => run());
  if (outcome === BUSY) {
    // ⚠ 문면이 **가리키는 것이 실제로 화면에 있어야 한다.** 이 갈래는 해제가 도는 동안에만
    //   서므로 진행 알림이 반드시 떠 있다 — 종전 문면(「진행 중인 알림을 확인해 주세요」)은
    //   가드가 묻는 자리까지 덮던 시절 **없는 알림을 가리키는** 말이었다.
    void vscode.window.showInformationMessage(
      "다른 소스를 푸는 중입니다 — 진행 알림이 끝나면 다시 눌러 주세요.",
    );
  }
  return outcome;
}

/**
 * **마지막으로 발급받은 미리보기 키.** `session` 이 아니라 여기 사는 이유(심의 경고 · 2026-08-10):
 * 종전에는 keyId 가 `session` 에만 있어서, 「미리보기 중지」 뒤 로그아웃하면 **서버 키를 못 지웠다.**
 * 프로세스는 죽었지만 키는 TTL(최대 12시간)까지 살아 있었고, 도움말은 "서버에서도 폐기됩니다"라고
 * 적혀 있었다 — 문서가 하지 않는 일을 했다고 말하는 자리였다.
 */
let issuedKey: { keyId: number; tenant: string } | null = null;
/**
 * 발급한 열쇠(`IssuedKey` = 아이디 + 사이트)의 **목록**을 창 밖으로 넘긴다. 모듈 메모리만으로는
 * 부족하다 —
 * 「중지」 뒤 창을 다시 열면(reload·재시작) 값이 사라져, 로그아웃해도 서버 키가 TTL(최대 12시간)까지
 * 살아 있었다. 도움말은 그 경로에서도 폐기된다고 무조건으로 약속하고 있었다.
 */
const ISSUED_KEY_STATE = "zalkera.issuedKey";

/**
 * 창 밖에 적어 둔 **전체 목록**을 읽는다. 한 칸이 아니라 목록인 이유는 `issuedKeys.ts` 에 있다 —
 * 요약하면 이 저장소는 창 사이에 공유되는데 미리보기는 창마다 켜기 때문이다.
 */
function recordedKeys(): IssuedKey[] {
  const {list, dropped} = readIssuedKeysWithOverflow(
    persistedState.get(ISSUED_KEY_STATE),
  );
  // 상한을 넘은 것은 **조용히 버리지 않는다** — 그 열쇠는 서버에서 살아 있고, 도움말은
  // 「로그아웃하면 폐기됩니다」를 무조건으로 약속한다(심의 권고).
  reapDropped(dropped);
  return list;
}

/**
 * 상한 때문에 목록에서 밀려난 열쇠를 **서버에서 지운다.**
 *
 * 기다리지 않는다 — 부르는 자리가 목록을 읽는 동기 경로이고, 폐기는 실패해도 사용자가 할 일을
 * 막지 않는다(`revokeKeyQuietly` 가 그 규율이다). 정상 사용에서는 늘 0건이다.
 */
function reapDropped(dropped: readonly IssuedKey[]): void {
  for (const key of dropped) {
    log(`미리보기 자격증명이 목록 상한을 넘어 밀려났습니다 — 서버에서 지웁니다(#${count(key.keyId)}).`);
    void revokeKeyQuietly(key.keyId, key.tenant);
  }
}
let persistedState: vscode.Memento;
/** 폴더 단위 기억 — 자격증명 경고가 사이트마다 다시 선다(`stateFor`). */
let workspaceScopedState: vscode.Memento;

/** 사이트별 마지막 로컬본 폴더. 창 사이에 공유된다. */
const FOLDER_REGISTRY_STATE = "zalkera.folderRegistry";

/**
 * **이 계정에 사이트가 여럿인가** — 사이드바가 「전환」을 말해도 되는지의 근거.
 *
 * 값은 고르는 창이 목록을 받을 때 남긴다(그 시점에 이미 손에 있으므로 **새 조회가 0**). 그전에는
 * `undefined` = **모름**이고, 사이드바는 모름을 「보여 주는 쪽」으로 다룬다 — 안 보여 주면 여러
 * 사이트를 맡은 사람이 전환할 자리를 잃는다.
 *
 * ⚠ 로그아웃에서 지운다. 남기면 **다음 사람의 계정에 앞사람의 사실**을 쓰게 된다.
 */
const CAN_SWITCH_STATE = "zalkera.canSwitch";

/** 모르면 `null` — `false`(하나뿐)와 **다른 값**이다. */
function canSwitchCached(): boolean | null {
  const v = persistedState.get(CAN_SWITCH_STATE);
  return typeof v === "boolean" ? v : null;
}

/**
 * 사이트 → 마지막 로컬본 절대경로.
 *
 * ⚠ **정본이 아니다.** 경로는 지워지고 옮겨지고 **재활용된다.** 제안 전에 반드시 그 폴더를 열어
 *   소속을 확인한다(`confirmedFolderFor`) — 기억만 믿고 열어 주면, 다른 사이트를 담게 된 폴더를
 *   「그 사이트 폴더」라고 내주는 바로 그 사고가 된다.
 */
function folderRegistry(): Record<string, string> {
  const raw = persistedState.get(FOLDER_REGISTRY_STATE);
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [site, dir] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof dir === "string" && dir.length > 0) out[site] = dir;
  }
  return out;
}

function rememberFolder(tenant: string, dir: string): void {
  void persistedState.update(FOLDER_REGISTRY_STATE, {...folderRegistry(), [tenant]: dir});
}

/** 계정이 바뀌면 통째로 버린다 — 앞사람의 사이트 코드와 폴더 경로가 남는 자리다. */
async function clearFolderRegistry(): Promise<void> {
  await persistedState.update(FOLDER_REGISTRY_STATE, undefined);
}

/**
 * 레지스트리가 기억하는 그 사이트의 폴더 — **확증까지 마친 것만** 돌려준다.
 * 폴더가 사라졌거나 그 사이 다른 사이트를 담게 됐으면 `null`.
 */
function confirmedFolderFor(tenant: string): string | null {
  const dir = folderRegistry()[tenant];
  if (dir === undefined || !existsSync(dir)) return null;
  const linked = workspaceLinkAt(dir);
  return folderBinding(readSourceMarkAt(dir), linked) === tenant ? dir : null;
}

/**
 * 그 폴더가 **자기 `.vscode/settings.json` 에** 적어 둔 사이트. 지금 창의 설정이 아니다 —
 * 다른 폴더를 확증하는 자리라 파일을 직접 읽는다.
 *
 * **판독은 여기 한 벌이다.** 「없다」와 「못 읽었다」를 갈라 돌려주고, 종전 계약이 필요한 자리는
 * `linkedTenantOf` 로 좁혀 쓴다 — 판독기가 둘이면 한쪽만 고쳐진다.
 *
 * ⚠ **JSONC 를 못 읽는다.** VS Code 는 주석·후행 쉼표가 있는 `settings.json` 을 정상으로 다루는데
 *   생 `JSON.parse` 는 던진다. 그래서 그 칸이 `unreadable` 이다 — 「없다」로 접으면 소속 있는
 *   폴더가 소속 없어 보인다(보안 심의 🟠). 왜 그 접힘이 위험한지는 core 쪽 KDoc 에 있다.
 */
function workspaceLinkState(dir: string): WorkspaceLink {
  const path = join(dir, ".vscode", "settings.json");
  const text = readSmallOwnFile(path);
  // 파일 자체가 없으면 「없다」, 파일은 있는데 못 읽었으면 「모른다」.
  if (text === null) {
    return existsSync(path) ? {kind: "unreadable"} : {kind: "absent"};
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return {kind: "unreadable"};
    const value = (raw as Record<string, unknown>)["zalkera.tenant"];
    return typeof value === "string" && value.length > 0
      ? {kind: "tenant", tenant: value}
      : {kind: "absent"};
  } catch {
    return {kind: "unreadable"};
  }
}

function workspaceLinkAt(dir: string): string | null {
  return linkedTenantOf(workspaceLinkState(dir));
}

/**
 * ⚠ **테넌트를 함께 들고 다닌다**(클로징 심의 차단 · 2026-08-10). 종전에는 keyId 만 캡처하고 폐기할 때
 * `tenantCode()` 를 **라이브로** 읽었다. 그런데 `zalkera.tenant` 는 워크스페이스 범위라 창마다 다르고,
 * 테넌트는 `x-tenant` 헤더로만 간다 — 창 A(테넌트 a)에서 발급한 키를 창 B(테넌트 b)에서 로그아웃하면
 * 폐기 요청이 b 로 나가 서버가 거절하고, catch 가 그것을 삼킨다. **A 의 키가 최대 12시간 산다.**
 *
 * T3 가 「올리기·전환」에 만든 "표기와 동작이 같은 값을 본다"를 이 호출부에 그대로 옮긴 것이다.
 */
function setIssuedKey(next: IssuedKey | null): void {
  const previous = issuedKey;
  issuedKey = next;
  // ⚠ **덮지 않고 더한다.** 이 저장소는 창 사이에 공유되므로 덮으면 다른 창의 열쇠가 사라지고,
  //   사라진 열쇠는 아무도 못 지운 채 TTL(최대 12시간)까지 산다.
  let list = recordedKeys();
  if (previous) list = removeIssuedKey(list, previous.keyId);
  if (next) {
    const merged = addIssuedKeyWithOverflow(list, next);
    reapDropped(merged.dropped);
    list = merged.list;
  }
  void persistedState.update(ISSUED_KEY_STATE, list);
}
let store: SecretTokenStore;
let handshake: Handshake | null = null;
let sidebar: ZalkeraSidebar;
/** 동봉 자원(npm)을 찾으려면 확장 설치 경로가 필요하다. */
let extensionPath: string;
/** 동봉 매뉴얼(media/help.md)의 위치. */
let helpUri: vscode.Uri;
let renewTimer: NodeJS.Timeout | null = null;
let diagnostics: vscode.DiagnosticCollection;
/**
 * 보호 경로 경고를 **종류마다 한 번만, 영구히.**
 *
 * ⚠ 종전에는 파일 경로로 셌고 그 목록이 **모듈 변수**였다. 그래서 「한 번」이 파일당이 아니라
 *   **세션당**이었고, VS Code 가 재시작하며 열려 있던 편집기를 되열면 경고창이 **한꺼번에 여럿**
 *   떴다(실측: `dist/` 아래 파일 셋 → 토스트 셋). 사용자가 읽는 것은 조언이 아니라
 *   「무슨 일이 났나」다. 조언은 파일마다 다르지 않고 셋뿐이므로 종류로 센다.
 */
const WARNED_KINDS_STATE = "zalkera.warnedProtectedKinds";

/**
 * ⚠ **자격증명만 폴더 단위다.** 나머지 둘(`node_modules`·빌드 산출물)은 「이 폴더 종류는 이런
 *   성질이다」라는 프로젝트 무관 사실이라 기계에서 한 번이면 족하다. 그러나 `.env` 는 **프로젝트
 *   마다 다른 비밀**을 지킨다 — 기계 단위로 묶으면 처음 연 사이트에서 한 번 뜨고, 몇 달 뒤 다른
 *   고객사 소스를 처음 손댈 때는 조용하다. 유출은 되돌리기가 가장 어려운 손해다.
 */
function stateFor(kind: ProtectedKind): vscode.Memento {
  return kind === "credential" ? workspaceScopedState : persistedState;
}

/** 이미 알린 종류. 타이핑마다 저장소를 읽지 않도록 이 창에서 본 것은 기억해 둔다. */
const warnedThisSession = new Set<ProtectedKind>();

function warnedKinds(kind: ProtectedKind): Set<string> {
  const raw = stateFor(kind).get(WARNED_KINDS_STATE);
  return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
}

/**
 * **manifest 에서 읽는다.** 종전에는 `"0.1.0"` 이 소스에 박혀 있어, 0.1.14 를 쓰는 사람도 서버에는
 * 0.1.0 으로 보였다 — 핸드셰이크의 `minClientVersion` 판정이 그 값을 본다. 두 곳에 적힌 값은 갈린다.
 */
let extensionVersion = "0.0.0";

/** 확장 뷰로 데려다 줄 때 쓰는 식별자. manifest 에서 읽는다 — 소스에 박으면 갈린다. */
let extensionId = "zalkera.zalkera-devtools";

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("잘커라");
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.command = "zalkera.preview.start";
  showIdleStatus();
  status.show();
  store = new SecretTokenStore(context);
  extensionPath = context.extensionPath;
  extensionVersion = String(
    context.extension.packageJSON.version ?? extensionVersion,
  );
  extensionId = context.extension.id || extensionId;
  persistedState = context.globalState;
  workspaceScopedState = context.workspaceState;
  // ⚠ **이어받지 않는다.** 적어 둔 목록에는 **다른 창이 켠 열쇠**가 섞여 있다. 그것을 이 창의
  //   `issuedKey` 로 삼으면, 시작 실패 롤백이 남의 열쇠를 지우고 제 것을 남긴다. 목록은
  //   로그아웃·초기화가 통째로 읽어 전부 지운다(`revokeRecordedKeys`).
  issuedKey = null;
  helpUri = vscode.Uri.joinPath(context.extensionUri, "media", "help.md");
  sidebar = new ZalkeraSidebar();
  void refreshSidebar();
  // ⚠ **비정상 상태가 조용해지지 않게 한다.** 갈아 끼우다 편집기가 죽으면 원래 소스가 형제
  //    자리의 숨은 폴더에 남는데, 그 사실을 아는 사람이 아무도 없다 — 지우지는 않고 **어디
  //    있는지만** 말한다(그 폴더가 원본의 유일한 사본일 수 있다).
  //
  // ⚠ **억제 상태를 저장하지 않는다.** 「한 번 말했으니 그만」으로 두면 잔재는 그대로인데 화면만
  //    조용해진다. 잔재가 있는 한 창을 열 때마다 말한다 — 치우면 저절로 멎는다.
  //
  // ⚠ **동기 구간에 I/O 를 안 더한다.** `void` 로 띄워 활성화를 안 붙든다.
  void announceStashLeftovers();
  // ⚠ **여는 제스처가 기억을 되살린다.** 레지스트리는 계정 자료라 로그아웃이 통째로 버리는데,
  //    디스크의 폴더는 그대로 남는다. 그 상태로 다시 로그인하면 로컬본이 있는데도 「받기」를
  //    권하게 된다 — 소속은 폴더 안 표식이 알고 있으므로, 그 폴더를 연 것만으로 되살린다.
  //    **표식이 정본이라 이 쓰기는 기억을 고칠 뿐 소속을 정하지 않는다.**
  rememberOpenFolder();

  diagnostics = vscode.languages.createDiagnosticCollection("zalkera");

  context.subscriptions.push(
    output,
    status,
    diagnostics,
    // F2 — 저장할 때와 열 때 본다. 타이핑마다 돌리지 않는다(계약 위반은 저장 시점에 확인해도 늦지 않다).
    vscode.workspace.onDidSaveTextDocument((doc) => refreshDiagnostics(doc)),
    vscode.workspace.onDidOpenTextDocument((doc) => refreshDiagnostics(doc)),
    // F1 — 되돌리기 어려운 자리를 **막지 않고 알린다**(고객 소스는 고객 것이다).
    // ⚠ **여는 것이 아니라 고칠 때 본다.** 읽으려고 여는 것은 해가 없고, 손해는 타이핑을
    //    시작할 때 생긴다. 열 때 보면 VS Code 가 다시 켜며 편집기를 한꺼번에 되열 때마다 경고가
    //    쏟아진다 — 되열기는 편집이 아니므로 이 자리에서는 구조적으로 안 온다.
    vscode.workspace.onDidChangeTextDocument((e) => {
      // 사람이 **타이핑을 시작한** 순간. 여기서만 `isDirty` 를 요구한다 — 디스크 재읽기도 이
      // 알림을 내는데, 그중에는 우리가 쓴 `.env.local` 이 있다.
      if (e.contentChanges.length > 0 && e.document.isDirty) warnProtectedPath(e.document);
    }),
    // ⚠ **여는 시점도 본다.** 에이전트·`git checkout` 처럼 **디스크에 직접 쓰는** 손은
    //    편집 알림을 «깨끗한» 문서로 내므로 위 갈래가 구조적으로 못 잡는다(심의 실증).
    //    그 파일을 사람이 **열어 볼 때**가 남은 유일한 기회다.
    //
    //    ⚠ 이 갈래가 옛 판에서 토스트를 쏟은 자리다. 그런데 그 원인은 트리거가 아니라
    //      **셈의 범위**였다 — 「경로별·세션당」이라 재시작이 편집기를 되열 때마다 처음이 됐다.
    //      지금은 「종류별·영구」라 한 종류에 평생 한 번이다. 셋을 넘을 수 없다.
    vscode.workspace.onDidOpenTextDocument((doc) => warnProtectedPath(doc)),
    vscode.window.registerTreeDataProvider("zalkera.sidebar", sidebar),
    register("zalkera.signIn", async () => {
      await signIn();
    }),
    register("zalkera.site.choose", chooseSite),
    register("zalkera.reset", resetAll),
    register("zalkera.signOut", async () => {
      await signOut();
    }),
    // ⚠ **등록부에서는 아무도 가드를 안 잡는다.** 가드가 막는 것은 «같은 폴더에 두 아카이브를
    //    동시에 푸는 것»이고(`reentrancy.ts`), 그 일은 명령 안쪽 한 구간에서만 일어난다 —
    //    거기서 `whileExtracting` 이 잡는다. 진입점에서 잡으면 로그인·폴더 고르기·완료 알림까지
    //    덮여, 답하지 않은 물음 하나가 창이 죽을 때까지 나머지 둘을 막는다.
    //
    // ⚠ **파일로 받는 둘은 가드 자체가 없다.** 폴더를 안 풀고 고르신 자리에 파일 하나를 놓으며,
    //    그 쓰기는 `writeOwnFile` 이 임시 파일 + `rename` 으로 원자적으로 한다.
    register("zalkera.preset.download", downloadPresetZipCommand),
    register("zalkera.site.downloadZip", downloadSourceZipCommand),
    register("zalkera.site.open", () => openSite()),
    register("zalkera.site.importZip", importZipCommand),
    register("zalkera.site.updateZip", updateZipCommand),
    register("zalkera.site.updateFromServer", updateFromServerCommand),
    register("zalkera.export", exportZipCommand),
    register("zalkera.folder.change", changeFolder),
    register("zalkera.site.link", linkFolder),
    register("zalkera.site.useFolder", useFolderSite),
    register("zalkera.preview.start", startPreviewCommand),
    register("zalkera.preview.stop", stopPreview),
    register("zalkera.preview.restart", async () => {
      await stopPreview();
      await startPreviewCommand();
    }),
    register("zalkera.publish", publishCommand),
    register("zalkera.version.switch", () => switchVersion()),
    register("zalkera.history", showHistory),
    register("zalkera.precheck", precheckCommand),
    register("zalkera.agent.connect", connectAgent),
    register("zalkera.help", showHelp),
    register("zalkera.doctor", doctor),
  );
}

export async function deactivate(): Promise<void> {
  clearRenewal();
  // 반영 확인은 **뒤에서 도는 폴링**이라 사람이 창을 닫아도 스스로 안 멈춘다 — 확장이 내려가는데
  // 조회가 계속 나가고, 알림이 뜨면 이미 없는 맥락을 말한다. 켜 둔 채 내려가는 것은 미리보기 서버와
  // 같은 종류의 고아다(바로 아래).
  stopReflectionWatches();
  // 미리보기를 켜 둔 채 창을 닫으면 dev 서버가 고아로 남는다 — 사용자는 그것을 볼 수도 끌 수도 없다.
  await session?.server.stop();
}

/**
 * 매뉴얼을 연다. **정본은 웹**이고(오너 확정 2026-08-10), 동봉본은 폴백이다.
 *
 * ■ 왜 웹이 정본인가
 *   확장은 고객 기계에 깔려 **강제 업데이트가 안 된다.** 동봉본만 두면 오탈자 하나 고치는 데 새 릴리스가
 *   필요하고, 안 올린 사람은 영영 옛 글을 본다. 웹은 고치는 즉시 모두에게 닿는다.
 *   그리고 설치 **전에** 읽을 수 있어야 한다 — 안 깔아 본 사람이 판단할 근거가 그것이다.
 *
 * ■ 그런데 왜 동봉본을 남기나
 *   매뉴얼이 제일 필요한 순간은 **뭔가 안 될 때**이고, 그때 안 되는 것이 인터넷일 수 있다.
 *
 * ■ 왜 열어 보기 전에 재나
 *   `openExternal` 은 **브라우저를 띄웠는가**만 알려 준다 — 그 페이지가 떴는지는 모른다. 그래서 그냥
 *   열면 오프라인 사용자는 브라우저 오류 화면을 보고 끝난다. 짧은 요청 한 번으로 먼저 확인한다.
 *   실패는 **정상 경로**다(오프라인·사내망 차단) — 조용히 동봉본으로 간다.
 *
 * ■ 주소는 **서버가 정한다**
 *   확장은 강제 업데이트가 안 되므로 주소를 박아 두면 호스트를 옮기는 날 전원이 새 VSIX 를 깔아야 한다.
 *   핸드셰이크의 `helpUrl` 을 먼저 보고, 없을 때만 아래 기본값을 쓴다. 지금 기본값이 GitHub Pages 인
 *   것은 **임시**이고, www 가 서면 서버 설정 한 줄로 옮겨진다 — 클라이언트 배포 0.
 */
const HELP_URL_FALLBACK = "https://zalkera.github.io/zalkera-devtools/";

async function showHelp(): Promise<void> {
  const url = await helpUrl();
  if (await reachable(url)) {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (opened) return;
    // 브라우저를 못 띄운 경우(원격·컨테이너 환경) — 여기서 끝내면 아무것도 안 열린다.
    log("브라우저를 열지 못해 동봉 매뉴얼을 엽니다.");
  }
  await openBundledHelp();
}

/**
 * 서버가 말한 주소 → 박힌 기본값 순.
 *
 * 핸드셰이크를 아직 안 받았으면 조용히 한 번 받아 본다. **실패는 삼킨다** — 도움말을 열려는데
 * 핸드셰이크 오류(구버전 경고 등)를 대신 띄우면 정작 도움말을 못 본다.
 *
 * ⚠ `http(s)` 만 받는다. 서버가 보낸 값이라도 그대로 `openExternal` 에 넘기지 않는다 — 잘못된 설정
 * 하나가 `file:`·`vscode:` 를 여는 통로가 되면 안 된다.
 */
async function helpUrl(): Promise<string> {
  if (!handshake) {
    try {
      await ensureHandshake();
    } catch {
      // 무시 — 기본값으로 간다.
    }
  }
  // 판정은 core 가 한다(§tenantScope). 여기서는 그 판단을 **말하기만** 한다 —
  // 조용히 기본값으로 돌아가면 운영자가 설정 오타를 영영 모른다.
  const resolved = resolveHelpUrl(handshake?.helpUrl, HELP_URL_FALLBACK);
  if (resolved.note) log(resolved.note);
  return resolved.url;
}

/** 2초 안에 응답이 오는가. 오래 기다리면 "도움말이 안 열린다"가 된다 — 그게 더 나쁜 고장이다. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 마크다운 미리보기가 없는 편집기(일부 경량 배포판)에서는 원문을 연다 — **못 여는 것보다 낫다.** */
async function openBundledHelp(): Promise<void> {
  try {
    await vscode.commands.executeCommand("markdown.showPreview", helpUri);
  } catch {
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(helpUri),
      { preview: false },
    );
  }
}

/**
 * 모든 명령을 한 자리에서 감싼다 — 오류를 **사람 말로** 보여 주는 곳이 여기 하나여야 한다.
 *
 * 지금 상태에서 요건이 안 갖춰진 명령이면 **왜인지 말하고 다음에 할 일을 준다.**
 *
 * 사이드바는 일곱 묶음을 항상 보여 준다 — 숨기면 「갱신이 안 됐다」로 읽히기 때문이다(오너 확정).
 * 그 대신 못 하는 이유를 **누를 때** 말한다. 판정은 core 가 하고(`whyBlocked`) 여기는 그린다.
 *
 * 막혔으면 `true` — 부르는 쪽은 손을 떼야 한다.
 */
async function announceIfBlocked(command: string): Promise<boolean> {
  const blocked = decideBlocked(command, {
    signedIn: (await store.read()) !== null,
    tenant: tenantCode(),
    site: siteDir(),
    folderTenant: currentFolderBinding(),
  });
  if (!blocked) return false;
  // ⚠ 어긋남 문면에는 폴더·서버가 정한 사이트 코드가 들어간다 — 소독은 core 안(`plainNotice`)에서
  //    이미 끝났다. 그래서 여기에 `ours` 를 붙이면 그 표기가 거짓이 된다.
  const buttons = [blocked.action, blocked.alternative].filter(
    (b): b is {label: string; command: string} => b !== undefined,
  );
  const picked = await vscode.window.showInformationMessage(
    blocked.message,
    ...buttons.map((b) => b.label),
  );
  const chosen = buttons.find((b) => b.label === picked);
  if (chosen) {
    await vscode.commands.executeCommand(chosen.command);
  }
  return true;
}

/**
 * 열린 폴더가 속한 사이트. 표식이 이기고, 없으면 워크스페이스 링크다.
 *
 * ⚠ 링크는 **병합 조회로 읽으면 안 된다** — 전역 값과 구분이 안 돼, 폴더가 아무것도 안 적었는데
 *   전역의 값을 그 폴더의 소속으로 오해한다.
 */
function currentFolderBinding(): string | null {
  const dir = workspaceDir();
  if (dir === undefined) return null;
  const linked =
    vscode.workspace.getConfiguration("zalkera").inspect<string>("tenant")
      ?.workspaceValue ?? null;
  return folderBinding(readSourceMarkAt(dir), linked);
}

/**
 * 지금 열린 폴더가 자기 사이트를 말하면 레지스트리에 다시 적는다.
 *
 * 같은 값이면 안 쓴다 — 창을 열 때마다 도는 자리라, 안 바뀐 값을 매번 쓰면 전역 상태가 창 수만큼
 * 흔들린다.
 */
function rememberOpenFolder(): void {
  const dir = workspaceDir();
  if (dir === undefined) return;
  const binding = currentFolderBinding();
  if (binding === null || folderRegistry()[binding] === dir) return;
  rememberFolder(binding, dir);
}

function register(
  command: string,
  handler: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async () => {
    try {
      if (await announceIfBlocked(command)) return;
      await handler();
    } catch (error) {
      // 판정은 core 가 한다(`errorNotice.ts`) — 이 자리는 시험도 검사기도 못 닿아서, 「취소는
      // 오류가 아니다」 갈래를 통째로 지워도 전건 초록이었다. 여기서는 그리기만 한다.
      const notice = decideErrorNotice(error);
      // 출력 채널에는 **원문**이 간다 — 링크를 렌더하지 않는 자리이고, 여기가 근거다.
      log(`${notice.logPrefix}: ${notice.raw}`);
      if (notice.kind === "cancelled") return;
      const choice = await vscode.window.showErrorMessage(
        notice.message,
        "자세히 보기",
      );
      if (choice === "자세히 보기") output.show();
    }
  });
}

// ── 인증 ────────────────────────────────────────────────────────────────

async function signIn(): Promise<boolean> {
  const config = await ensureHandshake();
  // **취소할 수 있어야 한다.** 이 대기는 사람의 브라우저 행동에 달려 있어, 그만두면 아무것도 오지
  // 않는다. 취소 경로가 없으면 알림이 기본 5분(코어 타임아웃)을 그대로 매달린다 — 실사용 신고.
  const cancelled = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "잘커라 로그인 — 브라우저에서 계속하세요",
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() =>
        controller.abort(),
      );
      try {
        await login(config.auth, store, {
          // 브라우저를 여는 방법만 확장이 안다 — 나머지 흐름은 코어가 갖는다.
          openBrowser: async (url) => {
            // ⚠ **반환값을 본다.** VS Code 는 외부 주소를 열기 전에 "이 사이트를 여시겠습니까?"
            // 확인창을 띄우고, 사용자가 거기서 취소하면 `false` 를 돌려준다. 이걸 무시하면
            // **브라우저는 열리지도 않았는데** 코어가 콜백을 기다려, 진행 알림이 남고
            // 사용자는 취소를 두 번 하게 된다(실사용 신고).
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened)
              throw new DevtoolsError("CANCELLED", "로그인을 취소했습니다.");
          },
          signal: controller.signal,
        });
        return false;
      } catch (error) {
        // 사람이 스스로 그만둔 것은 실패가 아니다 — 오류 창을 띄우지 않고 조용히 되돌린다.
        if (isCancelled(error)) return true;
        throw error;
      } finally {
        subscription.dispose();
      }
    },
  );
  if (cancelled) {
    // **토스트로 끝을 알린다.** 조용히 사라지면 "취소가 먹은 건가"를 남긴다 — 그 불확실이
    // 사용자를 다시 누르게 만든다. 오류 창(showErrorMessage)이 아닌 것은 실패가 아니어서다.
    log("로그인을 취소했습니다.");
    void vscode.window.showInformationMessage("로그인을 취소했습니다.");
    return false;
  }
  log("로그인했습니다.");
  await refreshSidebar();
  void vscode.window.showInformationMessage("잘커라에 로그인했습니다.");
  return true;
}

/** 로그아웃했으면 `true`, 준비 중이라 거절했으면 `false`. **호출부는 이 값을 봐야 한다.** */
async function signOut(options: { quiet?: boolean } = {}): Promise<boolean> {
  // 준비 중(수 분짜리 첫 설치)에 로그아웃하면, 이미 발급된 키로 진행 중인 시작이 **로그아웃 뒤에
  // 완주해** 미리보기가 선다 — 사이드바는 로그아웃 화면인데 상태바는 "미리보기 N"이 된다(심의 경고).
  // 지금은 준비를 중간에 끊을 수단이 없으므로 **거절하고 말한다.** 조용히 어긋나게 두지 않는다.
  if (previewGuard.busy) {
    void vscode.window.showWarningMessage(
      "미리보기를 준비하는 중입니다. 끝난 뒤 다시 시도해 주세요.",
    );
    return false;
  }
  // ⚠ **로그아웃이 반쪽이었다**(심의 경고): 도는 미리보기를 안 끄고 서버 키도 안 지웠다. 이미 뜬 dev 서버는
  // 부팅 때 읽은 키로 **최대 12시간 상용 데이터를 계속 읽는다** — "로그아웃했다"는 화면과 실제가 어긋난다.
  // 순서가 중요하다: 서버를 먼저 멈추고(그 키를 쓰는 프로세스를 없앤 뒤) 키를 지운다.
  //
  // 미리보기가 돌던 폴더를 **멈추기 전에** 잡는다. `stopPreview()` 뒤엔 `session` 이 사라져서,
  // 아래 `.env.local` 정리가 지금 창의 폴더를 지우게 된다 — 키가 있는 곳은 저쪽인데(클로징 심의).
  const previewDir = session?.projectDir ?? null;
  await stopPreview();
  // `session` 이 아니라 **적어 둔 목록 전부**를 본다 — 「중지」 뒤에도, 다른 창이 켠 것도 지운다.
  await revokeRecordedKeys();

  await logout(store);
  // ⚠ **사이트 설정을 `.env.local` 재작성보다 **먼저** 지운다. 그 재작성은 읽기전용·권한 등으로
  //    던질 수 있는데, 뒤에 두면 토큰은 지워졌는데 **사이트만 남는** 부분 실패가 된다(심의 관찰).
  //    지우는 순서는 「되돌릴 수 없는 것부터」가 아니라 「실패해도 다음이 도는 순서」다.
  await clearTenantSetting();
  // 사이트별 로컬본 지도도 계정 것이다 — 남기면 다음 사람에게 앞사람의 사이트 코드와 폴더
  // 경로가 보이고, 확장이 그 폴더를 열도록 **권한다.**
  await clearFolderRegistry();
  // 「사이트가 여럿인가」도 계정 사실이다 — 남기면 **다음 사람의 계정에 앞사람의 사실**을 쓴다.
  await persistedState.update(CAN_SWITCH_STATE, undefined);
  // 로컬 자격증명도 함께 지운다(A4) — **키 줄만** 지우고 고객이 넣은 값은 남긴다.
  const dir = previewDir ?? workspaceDir();
  if (dir) {
    const envPath = join(dir, ".env.local");
    if (existsSync(envPath)) {
      await writeOwnFile(
        envPath,
        stripCredentials(await readFile(envPath, "utf8")),
        0o600,
      );
      log(".env.local 의 미리보기 키를 지웠습니다(다른 설정은 그대로).");
    }
  }
  await refreshSidebar();
  // 초기화가 부를 때는 자기 문구로 끝낸다 — 알림이 두 번 뜨면 무엇이 끝난 건지 흐려진다.
  if (!options.quiet)
    void vscode.window.showInformationMessage("로그아웃했습니다.");
  return true;
}

/**
 * 처음 상태로 되돌린다(오너 확정 2026-08-10 · memo146 §15.4).
 *
 * 종전에는 완전 초기화에 **세 곳을 사람이 기억해야 했다** — 로그아웃 · 설정의 `zalkera.tenant` ·
 * 받은 폴더. 앞의 둘을 여기서 한 번에 한다.
 *
 * ⚠ **파일은 지우지 않는다.** 고치던 소스를 도구가 지우는 것이 이 도구가 낼 수 있는 가장 큰 손해다
 * (`fetchSiteSource` 가 빈 폴더를 요구하는 것과 같은 규율). 대신 **경로를 알려주고 사람이 지우게** 한다.
 */
async function resetAll(): Promise<void> {
  // signOut 과 **같은 이유로** 거절한다. 여기서 막지 않으면 signOut 이 조용히 되돌아온 뒤 설정만
  // 지워져서 — 로그인은 살아 있고 미리보기는 뒤늦게 뜨는데 사이트 설정만 사라진 — 최악의 중간 상태가 된다.
  const dir = workspaceDir();
  const confirmed = await vscode.window.showWarningMessage(
    "잘커라를 처음 상태로 되돌릴까요?",
    {
      modal: true,
      detail:
        "지웁니다: 로그인 · 작업 사이트 설정 · 미리보기 자격증명(서버에서도 폐기)\n" +
        "남깁니다: 받은 소스 폴더와 그 안의 내 설정",
    },
    "초기화",
  );
  if (confirmed !== "초기화") return;

  // 로그아웃이 이미 하는 일(미리보기 중지 → 서버 키 폐기 → 토큰 삭제 → .env.local 키 줄 제거)을
  // 그대로 쓴다. 두 벌로 만들면 한쪽만 고쳐진다.
  //
  // ⚠ **거절을 반드시 전달받는다**(심의 경고). 반환값을 안 보면, 확인창을 띄워 둔 사이에 갱신 타이머가
  // 미리보기를 다시 세워 signOut 이 거절하고 — 그런데 여기는 그대로 진행해 **설정만 지운다.** 로그인은
  // 살아 있고 미리보기는 뒤늦게 뜨는데 사이트 설정만 사라진, 주석이 스스로 최악이라 부른 그 상태다.
  if (!(await signOut({ quiet: true }))) return;

  // 사이트 설정은 로그아웃이 이미 지웠다(`ACCOUNT_SCOPED`). 두 벌로 두면 한쪽만 고쳐진다.

  // ⚠ **보호 경로 경고 기록도 지운다.** 「처음 상태로」라고 말해 놓고 이것만 남기면, 초기화한
  //    사람이 다시는 그 경고를 못 본다 — 그리고 되돌릴 방법이 화면 어디에도 없다.
  warnedThisSession.clear();
  await persistedState.update(WARNED_KINDS_STATE, undefined);
  await workspaceScopedState.update(WARNED_KINDS_STATE, undefined);

  log("초기화했습니다 — 로그인·사이트 설정·미리보기 자격증명을 지웠습니다.");
  await refreshSidebar();

  if (dir) {
    // 폴더는 안 지운다. 다만 **지우고 싶은 사람이 어디를 지워야 하는지 모르는 것**이 진짜 불편이므로
    // 경로를 손에 쥐여 준다.
    const choice = await vscode.window.showInformationMessage(
      "초기화했습니다. 받은 소스 폴더는 그대로 남아 있습니다.",
      "폴더 위치 열기",
    );
    if (choice === "폴더 위치 열기") {
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(dir),
      );
    }
    return;
  }
  void vscode.window.showInformationMessage("초기화했습니다.");
}

/**
 * 키 폐기는 **실패해도 로그아웃을 막지 않는다** — 사용자가 원한 것은 로그아웃이고, 서버가 잠깐 안 되는 것이
 * 그것을 되돌릴 이유가 되지 않는다. 대신 남은 키가 있다는 사실은 로그로 남긴다.
 */
async function revokeKeyQuietly(keyId: number, tenant: string): Promise<void> {
  try {
    const config = await ensureHandshake();
    const api = new ZalkeraApi({
      apiBase: apiBase(),
      accessToken: () => getAccessToken(config.auth, store),
      // **키를 발급받은 그 테넌트**로 폐기한다. 지금 고른 사이트가 아니다.
      tenantCode: () => tenant,
    });
    await api.revokeStorefrontKey(keyId);
    log("미리보기 자격증명을 서버에서 폐기했습니다.");
  } catch (error) {
    log(
      `미리보기 자격증명 폐기 실패(만료까지 유효할 수 있습니다): ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * **적어 둔 열쇠를 전부 폐기한다.** 하나가 실패해도 나머지를 계속 지운다 — 하나 때문에 전부
 * 남으면 그 열쇠들이 최대 12시간 상용 데이터를 읽는다.
 *
 * 지운 것은 **그때그때** 목록에서 뺀다. 끝나고 한 번에 비우면, 도중에 죽었을 때 폐기한 것과
 * 못 한 것이 함께 사라진다.
 */
async function revokeRecordedKeys(): Promise<void> {
  // ⚠ **이 창의 열쇠를 목록과 합친다.** 저장은 비동기다(`setIssuedKey` 가 `update` 를 안 기다린다)
  //    — 발급 직후 로그아웃하면 그 열쇠가 아직 목록에 없을 수 있고, 목록만 보면 **아무도 못 지운
  //    채 TTL(최대 12시간)까지 산다.** 모듈 메모리의 값이 이 창에 대해서는 늘 앞선다.
  const mine = issuedKey;
  issuedKey = null;
  const doomed = mine ? addIssuedKey(recordedKeys(), mine) : recordedKeys();

  // 지운 것은 **그때그때** 목록에서 뺀다. 끝나고 한 번에 비우면, 도중에 죽었을 때 폐기한 것과
  // 못 한 것이 함께 사라진다.
  //
  // 뒤늦게 도착한 저장이 이미 지운 항목을 되살릴 수는 있다. 그것은 **해가 없다** — 서버에서는
  // 이미 폐기됐고 다음 폐기 시도는 조용히 실패한다. 반대(못 지움)만 값이 크다.
  const revoked = new Set<number>();
  for (const key of doomed) {
    await revokeKeyQuietly(key.keyId, key.tenant);
    revoked.add(key.keyId);
    await persistedState.update(
      ISSUED_KEY_STATE,
      recordedKeys().filter((k) => !revoked.has(k.keyId)),
    );
  }
}

// ── 사이트 가져오기 ──────────────────────────────────────────────────────

/**
 * B2 — **이미 있는 사이트를 로컬로.** 처음 받는 것과 **다시 받는 것**이 같은 명령이다.
 *
 * ■ 왜 이름을 가르지 않았나
 *   동작이 문자 그대로 같다 — 같은 코어 함수, 같은 결과(빈 새 폴더에 그 판). 이름을 가르면
 *   검사기·문서·로그가 두 벌이 되고, 언젠가 한쪽만 고쳐진다. 처음/다시의 맥락은 명령 이름이
 *   아니라 **흐름 속 문장**이 싣는다.
 *
 * ■ 아무것도 덮어쓰지 않는다
 *   받기는 **빈 새 폴더**로만 간다(`fetchSiteSource` 가 그것을 강제한다). 지금 폴더는 손대지
 *   않는다 — 그 사실을 대화상자 제목과 완료 알림이 말한다. 고친 것을 옮기는 것은 사람 몫이고,
 *   우리는 병합하지 않는다.
 */
async function openSite(pinned?: CapturedTenant): Promise<void> {
  // ⚠ `ensureApi()` 가 아니라 **`ensureApiFor()`** 다. 이 명령은 사이트 이름을 화면에 말하는데,
  //    표기와 동작이 같은 값을 보려면 캡처된 테넌트가 필요하다(`tenantScope.ts` 의 규율).
  //
  // `pinned` 는 「고른 사이트가 이 폴더 것이 아니다」 흐름이 넘긴다. 그 창의 유효 사이트는 아직
  // 폴더의 것이라, 붙들어 오지 않으면 **엉뚱한 사이트의 소스**를 받는다.
  const { api, tenant } = await ensureApiFor(pinned);

  // 판을 **먼저 정한다.** 코어 폴백에 맡기면 ⑴ 받기 전에 판 번호를 말할 수 없고 ⑵ 화면에 말한
  // 판과 실제로 받는 판이 갈릴 수 있으며 ⑶ 켜진 판이 없을 때 목록 첫 줄(BUILDING 일 수 있다)을
  // 잡는다.
  const revisions = await api.listRevisions();
  const choice = pickRevision(revisions);
  // 「없다」의 이유는 둘이고 다음에 할 일이 정반대다 — 판정은 core 가 한다(`noRevisionError`).
  if (!choice) throw noRevisionError(revisions);
  if (choice.why === "latest-ready") {
    log(say.pickedLatestReady(tenant, choice.revisionNo));
  }

  const openDir = workspaceDir();
  const target = await chooseFetchTarget(tenant, choice.revisionNo, openDir);
  if (!target) return;

  // ⚠ **가드는 여기서부터다.** 위의 로그인·판 고르기·받을 자리 묻기는 사람의 답을 기다리는
  //    구간이라, 덮으면 답 없는 물음 하나가 형제 명령을 영영 막는다(`whileExtracting`).
  const result = await whileExtracting(() =>
    vscode.window.withProgress<FetchSourceResult>(
      {
        location: vscode.ProgressLocation.Notification,
        title: say.fetchProgress(tenant, choice.revisionNo),
      },
      () =>
        fetchSiteSource({
          api,
          revisionNo: choice.revisionNo,
          targetDir: target,
          onProgress: log,
        }),
    ),
  );
  if (result === BUSY) return;

  const root = await findProjectRoot(target);
  log(
    `버전 ${count(result.revisionNo)} · 파일 ${count(result.fileCount)}개를 받았습니다.`,
  );
  log(`받은 곳: ${root}`);
  if (openDir && openDir !== root) log(`이전 폴더는 그대로 있습니다: ${openDir}`);

  await writeSourceMark(root, tenant, result);
  await linkFolderToSite(root, tenant);
  rememberFolder(String(tenant), root);

  // ⚠ 받은 폴더가 **지금 열린 폴더**일 수 있다. 그때 갱신하지 않으면 사이드바가 계속 「불러오기」에
  //    머물러 미리보기·발행으로 가는 길이 화면에서 끊긴다.
  await refreshSidebar();

  // 판정은 core 가 한다 — 이 자리는 확장 안 조건문으로 뒀다가 **두 번** 틀렸다(`decideFetchedInto`).
  const { into, needsOpen } = decideFetchedInto({
    openDir: openDir ?? null,
    target,
    root,
  });
  const message =
    say.fetched(tenant, result.revisionNo, into) +
    (into === "sibling" && session !== null
      ? " 폴더를 열면 지금 미리보기는 멈춥니다 — 새 폴더에서 다시 시작해 주세요."
      : "");
  if (!needsOpen) {
    // `say` 가 만든 문장이다 — 서버 값은 그 안에서 이미 소독을 지났다(`tenantScope.ts` 의 `shown`).
    void vscode.window.showInformationMessage(ours(message));
    return;
  }
  const open = await vscode.window.showInformationMessage(
    ours(message),
    into === "into-open-nested"
      ? "소스 폴더 열기"
      : into === "sibling"
        ? "새 폴더 열기"
        : "이 폴더 열기",
  );
  if (open) {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(root),
      { forceNewWindow: false },
    );
  }
}

/**
 * 받을 폴더를 정한다. **아무것도 덮어쓰지 않는다** — 이름이 남의 것이면 비키고, 같은 판을 이미
 * 받아 둔 폴더면 그것을 알린다.
 *
 * 옆에 새 폴더를 **제안**하는 이유: 「빈 폴더를 새로 만들어 고르세요」는 비개발자가 멈추는
 * 자리다(탐색기로 올라가 → 새 폴더 → 이름 → 선택). 기본값을 주되 「다른 폴더 고르기」는 남긴다.
 */
async function chooseFetchTarget(
  tenant: CapturedTenant,
  revisionNo: number,
  openDir: string | undefined,
): Promise<string | undefined> {
  // ⚠ **빈 폴더를 열어 두고 온 사람에게 「빈 폴더를 고르세요」라고 다시 묻지 않는다.** 그 사람은
  //    이미 자리를 골랐다 — 못 읽으면 탐색기로 올라가 새 폴더를 만들게 하는 왕복이 생기고, 그것이
  //    비개발자가 멈추는 자리다. 판정은 core 가 하고 빈 폴더 여부만 여기서 잰다.
  // ⚠ **`siteFolderOpen` 을 먼저 잰다.** 참이면 `decideFetchTargetPlan` 이 첫 줄에서 `sibling` 을
  //    돌려주고 빈 폴더 판정을 버린다 — 그 자리에서 `readdir` 을 미리 돌면 매번 버려질 I/O 다.
  const siteFolderOpen = siteDir() !== null;
  const plan = decideFetchTargetPlan({
    openDir: openDir ?? null,
    openDirReceivable:
      !siteFolderOpen && openDir !== undefined && (await isReceivable(openDir)),
    siteFolderOpen,
  });
  if (plan.kind === "here") {
    const HERE = "이 폴더에 받기";
    const answer = await vscode.window.showInformationMessage(
      // ⚠ `fetchTargetHere` 를 쓰지 않는다 — 그 문장은 「지금 폴더는 그대로 둡니다」로 시작하는데
      //    여기서는 그 폴더가 곧 대상이다. 동의를 구하는 문장이 자기모순이면 동의가 아니다.
      ours(say.fetchTargetIntoOpen(tenant, revisionNo, plan.dir)),
      HERE,
      "다른 폴더 고르기…",
    );
    if (answer === undefined) return undefined;
    if (answer === HERE) return plan.dir;
  }
  const suggestion = plan.kind === "sibling" && openDir ? suggestSibling(openDir, revisionNo) : null;
  if (suggestion) {
    // 같은 판을 이미 받아 둔 폴더가 있으면 사본을 하나 더 만들기 전에 그 사실을 말한다.
    // **막지는 않는다** — 사본이 망가져서 다시 받는 경우가 있다.
    if (holdsSameRevision(readSourceMarkAt(suggestion.preferred), tenant, revisionNo)) {
      const answer = await vscode.window.showInformationMessage(
        ours(say.alreadyFetchedAt(tenant, revisionNo, suggestion.preferred)),
        "그 폴더 열기",
        "그래도 새로 받기",
      );
      if (answer === undefined) return undefined;
      if (answer === "그 폴더 열기") {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(suggestion.preferred),
          { forceNewWindow: false },
        );
        return undefined;
      }
    }
    const choices = suggestion.free
      ? ["옆에 새 폴더로 받기", "다른 폴더 고르기…"]
      : ["다른 폴더 고르기…"];
    const pick = await vscode.window.showInformationMessage(
      ours(
        suggestion.free
          ? say.fetchTargetHere(tenant, revisionNo, suggestion.free)
          : `${say.fetchTargetTitle(tenant, revisionNo)} (옆에 만들 이름을 못 정했습니다 — 직접 골라 주세요.)`,
      ),
      ...choices,
    );
    if (pick === undefined) return undefined;
    if (pick === "옆에 새 폴더로 받기" && suggestion.free) {
      try {
        // `recursive: false` — 이미 있으면 던진다. **덮어쓰기로 흘러가지 않는다.**
        await mkdir(suggestion.free, { recursive: false });
        return suggestion.free;
      } catch (error) {
        // 상위 폴더에 못 쓰는 경우다. 조용히 실패하지 않고 고르는 길로 떨어진다.
        log(
          `옆에 폴더를 만들지 못했습니다(${error instanceof Error ? error.message : error}) — 직접 골라 주세요.`,
        );
      }
    }
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "여기에 받기",
    defaultUri: openDir ? vscode.Uri.file(dirname(openDir)) : undefined,
    title: say.fetchTargetTitle(tenant, revisionNo),
  });
  return picked?.[0]?.fsPath;
}

/** 옆에 만들 이름. `preferred` 는 판 번호가 정하는 이름, `free` 는 실제로 비어 있는 이름. */
function suggestSibling(
  openDir: string,
  revisionNo: number,
): { preferred: string; free: string | null } {
  const parent = dirname(openDir);
  const base = suggestFolderName(basename(openDir), revisionNo);
  const free = nextAvailableName(base, (name) => existsSync(join(parent, name)));
  return {
    preferred: join(parent, base),
    free: free === null ? null : join(parent, free),
  };
}

function readSourceMarkAt(dir: string): SourceMark | null {
  return parseSourceMark(readSmallOwnFile(join(dir, SOURCE_MARK_PATH)));
}

/** 표식·설정처럼 **작아야 정상인** 파일의 상한. 넘으면 그 파일은 우리 것이 아니다. */
const SMALL_FILE_LIMIT = 64 * 1024;

/**
 * 이 자리들은 **모든 명령 진입점**에서 읽힌다(`announceIfBlocked`). 그래서 생 `readFileSync` 를
 * 쓰지 않는다 — 표식이 심링크로 `/dev/zero` 류를 가리키면 확장이 통째로 멈춘다.
 *
 * `writeOwnFile` 이 쓰기에서 잎 심링크를 거부하는 것과 **같은 규율의 읽기 쪽**이다.
 * 못 읽으면 `null` — 「없다」가 아니라 「모른다」이고, 모르는 폴더는 아무것도 막지 않는다.
 */
function readSmallOwnFile(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > SMALL_FILE_LIMIT) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * 출처 표식을 남긴다. **판정과 쓰기는 core 에 있다** — 확장 안에 두면 시험도 검사기도 못 닿아,
 * 심링크를 따라가거나 반쪽 파일을 남겨도 전건 초록이 된다(실제로 그 상태였다).
 * 쓰기 실패는 받기를 실패로 만들지 않는다.
 */
async function writeSourceMark(
  root: string,
  tenant: CapturedTenant,
  result: FetchSourceResult,
): Promise<void> {
  const done = await writeSourceMarkTo(root, {
    tenant: String(tenant),
    revisionNo: result.revisionNo,
    sha256: result.sha256,
    fetchedAt: new Date().toISOString(),
  });
  if (!done.ok) {
    log(`출처 표식을 남기지 못했습니다(${done.reason}) — 받기 자체는 끝났습니다.`);
  }
}

/** 새 폴더가 그 사이트를 바라보게 한다. 판정과 쓰기는 core(`linkFolderToTenant`). */
async function linkFolderToSite(
  root: string,
  tenant: CapturedTenant,
): Promise<void> {
  const done = await linkFolderToTenant(root, String(tenant));
  if (done.ok) {
    log("이 폴더를 지금 사이트에 연결해 두었습니다 — 폴더를 열면 바로 이어집니다.");
    return;
  }
  log(
    `사이트에 연결을 적지 못했습니다(${done.reason}). 새 폴더를 연 뒤 「사이트에 연결」을 눌러 주세요.`,
  );
}

/**
 * 「작업 폴더 변경」 — **창만 옮긴다.**
 *
 * ⚠ **아무것도 적지 않는다.** 링크도 표식도 전역 사이트도 쓰지 않는다 — 소속을 **바꾸는** 동사는
 *   「사이트에 연결」 하나로 남긴다(`decidePickedFolder` 가 세운 규율). 고르신 폴더가 남의 사이트
 *   것이어도 막지 않는다: 도착한 창의 어긋남 표면(상태바 경고·「이 폴더의 사이트로 돌아가기」)이
 *   받고, 마지막 방어선은 발행 확인이다. 사전 게이트를 달면 「모르는 것으로는 막지 않는다」와
 *   어긋난다.
 *
 * ⚠ **`openSiteFolder` 를 지난다.** 직접 여는 것과 다른 점은 미리보기가 돌거나 저장 안 된 편집이
 *   있을 때 **새 창**을 기본으로 준다는 것이다 — 파일 → 폴더 열기에는 없는 보호이고, 이 문이
 *   존재할 값어치의 절반이 거기 있다.
 */
async function changeFolder(): Promise<void> {
  const plan = changeFolderPlan({
    openDir: workspaceDir() ?? null,
    // 확증(실재 + 소속 일치)을 지난 것만 제안한다 — 기억만 믿고 열어 주는 것이 이 설계가 막는 사고다.
    confirmedDir: confirmedFolderFor(tenantCode()),
  });
  if (plan.kind === "offer") {
    const OPEN = "폴더 열기";
    const picked = await vscode.window.showQuickPick(
      [
        {label: OPEN, detail: plainNotice(plan.dir, 120)},
        {label: "다른 폴더 고르기…", detail: "이 창을 그 폴더로 옮깁니다 — 소속은 바뀌지 않습니다"},
      ],
      {title: "작업 폴더 변경"},
    );
    if (picked === undefined) return;
    if (picked.label === OPEN) {
      // ⚠ **누른 시점에 다시 확증한다** — 목록을 만든 뒤 폴더가 사라지거나 다른 사이트를 담게
      //    됐을 수 있고, 그때 여는 것이 이 규율이 막는 사고다(`runElsewhere` 와 같은 잣대).
      const still = confirmedFolderFor(tenantCode());
      // ⚠ **보인 것과 여는 것이 같아야 한다.** `null` 만 보면, 목록을 띄운 사이 다른 창이
      //    레지스트리를 바꿨을 때 `detail` 에 적힌 것과 **다른 폴더**가 열린다 — 이 축의 주제가
      //    바로 「보이는 것과 실제가 갈리지 않게」다.
      if (!folderStillShown(still, plan.dir)) {
        void vscode.window.showInformationMessage(
          ours("그 폴더를 더는 찾지 못했습니다 — 직접 골라 주세요."),
        );
        return;
      }
      await openSiteFolder(still);
      return;
    }
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "이 폴더로 옮기기",
    defaultUri: workspaceDir() ? vscode.Uri.file(dirname(workspaceDir() as string)) : undefined,
    title: "작업 폴더 변경",
  });
  const dir = chosen?.[0]?.fsPath;
  if (dir === undefined) return;
  await openSiteFolder(dir);
}

/**
 * 그 사이트 폴더를 연다.
 *
 * ⚠ **지금 창을 함부로 뺏지 않는다.** 미리보기가 돌거나 저장 안 된 편집기가 있으면 **새 창**을
 *   기본으로 준다 — 「잠깐 다른 사이트만 볼까」가 파괴적이면 안 된다. 그 둘이 없으면 이 창에서
 *   열어 창이 늘어나지 않게 한다.
 *
 * 미리보기는 창마다 따로 서고 발급된 열쇠도 창 밖 목록에 함께 적히므로(`recordedKeys`),
 * 새 창을 여는 것 자체는 지금 미리보기를 깨지 않는다.
 */
async function openSiteFolder(dir: string): Promise<void> {
  const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty);
  if (session === null && !dirty) {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir));
    return;
  }
  const reason = session !== null ? "미리보기가 돌고 있습니다" : "저장하지 않은 편집기가 있습니다";
  const picked = await vscode.window.showWarningMessage(
    ours(`${reason} — 새 창에서 열면 지금 창은 그대로 둡니다.`),
    { modal: true },
    "새 창에서 열기",
    "이 창에서 열기",
  );
  if (picked === undefined) return;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), {
    forceNewWindow: picked === "새 창에서 열기",
  });
}

/**
 * 「zip 으로 내보내기」 — 이 폴더를 **넘길 수 있는 zip** 으로 만든다.
 *
 * ⚠ **손으로 압축하면 안 되는 이유가 이 명령의 존재 이유다.** 폴더를 그냥 압축하면 `.env.local`
 *   (우리가 발급한 미리보기 키)·`.mcp.json`·`.ssh`·`.aws` 가 딸려 가고, 그러면 **고객 자격증명이
 *   받는 사람 손에 들어간다.** 발행이 쓰는 포장기를 그대로 쓴다 — 규칙을 두 벌로 두면 갈린다.
 *
 * 검사(`precheck`)를 강제하지 않는다. 이 도구는 조언하지 막지 않는다 — 넘기는 사람이 무엇을
 * 넘기는지 알면 된다.
 */
async function exportZipCommand(): Promise<void> {
  const dir = requireWorkspace();
  const suggested = `${basename(dir)}-source.zip`;
  const saveAt = await vscode.window.showSaveDialog({
    title: "넘기실 zip 을 저장할 곳",
    defaultUri: vscode.Uri.file(join(dirname(dir), suggested)),
    filters: {"사이트 소스": ["zip"]},
  });
  if (!saveAt) return;

  // ⚠ **출처 표시는 «지금 소속»으로 찍는다.** 연결 안 된 폴더면 안 찍는다 — 없는 정체성을
  //   지어내면 받는 쪽이 틀린 확신을 얻는다.
  const provenanceTenant = currentFolderBinding() ?? undefined;
  const result = await vscode.window.withProgress(
    {location: vscode.ProgressLocation.Notification, title: "사이트 소스를 포장하는 중"},
    () => packProject({projectDir: dir, provenanceTenant, onProgress: log}),
  );
  await writeOwnFile(saveAt.fsPath, result.buffer);

  log(`파일 ${count(result.fileCount)}개 · ${Math.round(result.buffer.length / 1024)}KB 로 포장했습니다.`);
  log(`sha256: ${result.sha256}`);
  void vscode.window.showInformationMessage(
    // ⚠ **「전부 뺐다」고 말하지 않는다.** `isSecretFile` 이 스스로 보증을 좁혀 뒀다 — 우리가
    //    발급한 `.env*` 는 반드시, 널리 쓰이는 표준 자격증명 이름은 최선, 그 밖은 보증하지
    //    않는다. 「전부 막는다」고 적으면 못 막은 하나가 배신이 된다.
    ours(
      "사이트 소스를 zip 으로 내보냈습니다. 미리보기 열쇠와 널리 쓰이는 자격증명 파일, " +
        "빌드 산출물은 뺐습니다 — 넘기시기 전에 출력 패널에서 무엇이 빠졌는지 확인해 주세요.",
    ),
  );
}

/**
 * 파일로 내놓을 때 **처음 보여 줄 자리.** 열린 폴더의 옆, 없으면 홈.
 *
 * ⚠ 이름은 **서버 값에서 그대로 짓지 않는다** — `safeFileName` 을 지난 것만 쓴다. 팩 코드나
 *   사이트 코드에 `../` 가 섞이면 기본 경로가 폴더 밖을 가리키고, 사람은 대화상자에 이미
 *   채워진 그 경로를 읽지 않는다.
 */
function suggestSavePath(name: string): vscode.Uri {
  const dir = workspaceDir();
  return vscode.Uri.file(join(dir === undefined ? homedir() : dirname(dir), name));
}

/**
 * 「예제 zip 다운로드」 — 시작 소스 팩을 **파일 하나로** 받는다.
 *
 * ⚠ **풀지 않는다.** 종전에는 빈 폴더를 골라 바로 풀었는데, 그러면 소스가 있는 창에서는 쓸 수
 *   없어(빈 폴더가 필요하다) 이 항목이 화면에서 사라졌다. 파일로 받으면 어느 상태에서나 안전해
 *   늘 보일 수 있고, 받은 zip 은 「zip 으로 시작」·「zip 으로 교체」 둘 다에 그대로 들어간다.
 *
 * 무결성 대조는 `fetchPresetZip` 이 한다 — 검증 안 된 zip 을 디스크에 남기면 그것이 그대로
 * 「zip 으로 교체」의 재료가 된다.
 */
async function downloadPresetZipCommand(): Promise<void> {
  const api = await ensureApi();
  const presets = await api.listPresets();
  if (presets.length === 0) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "지금 고를 수 있는 시작 소스가 없습니다.",
      "잘커라 콘솔에서 시작 소스를 확인해 주세요.",
    );
  }

  const choice = await vscode.window.showQuickPick(
    presets.map((p) => ({
      label: p.name,
      description: `${p.code} · ${p.version}`,
      detail: p.description,
    })),
    {title: "어떤 예제를 받을까요?"},
  );
  const preset = presets.find((p) => `${p.code} · ${p.version}` === choice?.description);
  if (!preset) return;

  const suggested = `${safeFileName(preset.code, "preset")}-${safeFileName(preset.version, "0")}.zip`;
  const saveAt = await vscode.window.showSaveDialog({
    title: "예제 zip 을 저장할 곳",
    defaultUri: suggestSavePath(suggested),
    filters: {"사이트 소스": ["zip"]},
  });
  if (!saveAt) return;

  const pack = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${plainNotice(preset.name, 64)} 를 받는 중`,
    },
    () => fetchPresetZip({api, presetCode: preset.code, onProgress: log}),
  );
  await writeOwnFile(saveAt.fsPath, pack.bytes);

  log(`예제 ${pack.presetCode}@${pack.version} · ${Math.round(pack.bytes.length / 1024)}KB`);
  log(`sha256: ${pack.sha256}`);
  log(`받은 곳: ${saveAt.fsPath}`);
  void vscode.window.showInformationMessage(
    // ⚠ `preset.name` 은 서버 응답이다. 소독 없이 넣으면 비-모달 알림이 `[글](command:…)` 를
    //   클릭 링크로 렌더한다(심의 실증).
    ours(
      `${plainNotice(preset.name, 64)} 예제를 zip 으로 받았습니다. ` +
        "「zip 으로 시작」으로 새 빈 폴더에 푸시면 됩니다.",
    ),
  );
}

/**
 * 「소스 zip 다운로드」 — 배포 중인 판을 **파일 하나로** 받는다. 폴더에 풀지 않는다.
 *
 * ⚠ **서버 정본은 tar.gz 이고 우리 들여오기 문은 zip 만 받는다.** 그래서 `downloadSourceZip` 이
 *   받아서 「zip 으로 내보내기」와 **같은 포장기**로 다시 싼다. 그 결과 여기서 받은 파일은
 *   「zip 으로 시작」·「zip 으로 교체」에 그대로 들어간다 — 안 그러면 「받았는데 못 넣는 파일」이 된다.
 *
 * ⚠ **두 해시는 다른 물건의 것이다.** `sourceSha256` 은 서버 정본 tar.gz 의 것이라 서버에 대조할 수
 *   있고, `zipSha256` 은 우리가 방금 만든 zip 의 것이라 서버는 모른다. 한 줄로 뭉쳐 적으면 받는
 *   사람이 서버에 맞춰 보려다 못 맞춘다.
 */
async function downloadSourceZipCommand(): Promise<void> {
  const {api, tenant} = await ensureApiFor();

  // `openSite` 와 같은 규율 — 판을 **먼저 정한다.** 코어 폴백에 맡기면 화면에 말한 판과 받는 판이
  // 갈릴 수 있고, 켜진 판이 없을 때 목록 첫 줄(BUILDING 일 수 있다)을 잡는다.
  const revisions = await api.listRevisions();
  const choice = pickRevision(revisions);
  if (!choice) throw noRevisionError(revisions);
  if (choice.why === "latest-ready") log(say.pickedLatestReady(tenant, choice.revisionNo));

  const suggested = `${safeFileName(String(tenant), "site")}-r${safeFileName(String(choice.revisionNo), "0")}.zip`;
  const saveAt = await vscode.window.showSaveDialog({
    title: "소스 zip 을 저장할 곳",
    defaultUri: suggestSavePath(suggested),
    filters: {"사이트 소스": ["zip"]},
  });
  if (!saveAt) return;

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: say.fetchProgress(tenant, choice.revisionNo),
    },
    () =>
      downloadSourceZip({
        api,
        revisionNo: choice.revisionNo,
        // 출처 표시는 **받아 온 그 사이트**로 찍는다 — 이 zip 이 어디서 왔는지가 곧 이 파일의 정체다.
        provenanceTenant: String(tenant),
        onProgress: log,
      }),
  );
  await writeOwnFile(saveAt.fsPath, result.buffer);

  log(
    `버전 ${count(result.revisionNo)} · 파일 ${count(result.fileCount)}개 · ` +
      `${Math.round(result.buffer.length / 1024)}KB`,
  );
  log(`정본 tar.gz sha256(서버 대조값): ${result.sourceSha256}`);
  log(`받으신 zip sha256(여기서 포장): ${result.zipSha256}`);
  log(`받은 곳: ${saveAt.fsPath}`);
  void vscode.window.showInformationMessage(
    // ⚠ **「전부 뺐다」고 말하지 않는다** — 형제 「zip 으로 내보내기」와 같은 이유다(`isSecretFile` 이
    //   스스로 보증을 좁혀 뒀다). 「전부 막는다」고 적으면 못 막은 하나가 배신이 된다.
    ours(
      `버전 ${count(result.revisionNo)} 소스를 zip 으로 받았습니다. 미리보기 열쇠와 널리 쓰이는 ` +
        "자격증명 파일, 빌드 산출물은 뺐습니다 — 「zip 으로 시작」·「zip 으로 교체」에 바로 쓰실 수 있습니다.",
    ),
  );
}

/**
 * zip 을 풀 자리. **받기와 같은 판정을 지난다**(`decideFetchTargetPlan`) — 빈 폴더를 열어 두고 온
 * 사람에게 「빈 폴더를 고르세요」라고 다시 묻지 않는 것이 그 판정의 요점이다.
 *
 * ⚠ **`here` 갈래만 산다.** 받기의 `sibling`(옆에 `이름-v판`)은 판 번호를 아는 쪽의 제안이고,
 *   zip 은 어느 판인지 모른다 — 소스 폴더 옆에 뜻 없는 이름을 지어 주지 않는다.
 *
 * 빈 폴더 **강제**는 여기가 아니라 `importZipInto` 가 실행 시점에 다시 잰다. 제안과 강제를 한
 * 판정으로 합치지 않는다 — 고르고 푸는 사이에 파일이 생길 수 있다.
 */
async function chooseImportTarget(
  pinned?: CapturedTenant,
): Promise<string | undefined> {
  const openDir = workspaceDir();
  // ⚠ **`siteFolderOpen` 을 먼저 잰다** — 참이면 판정이 `sibling` 을 돌려주며 빈 폴더 판정을
  //    버린다(그 자리에서 `readdir` 을 미리 돌면 매번 버려질 I/O 다).
  const siteFolderOpen = siteDir() !== null;
  const plan = decideFetchTargetPlan({
    openDir: openDir ?? null,
    openDirReceivable:
      !siteFolderOpen && openDir !== undefined && (await isReceivable(openDir)),
    siteFolderOpen,
  });
  if (plan.kind === "here") {
    const HERE = "이 폴더에 풀기";
    const answer = await vscode.window.showInformationMessage(
      // ⚠ **사이트 이름을 적지 않는다.** 「zip 으로 시작」은 로그인만 요구하고 그 zip 이 어느
      //    사이트 것인지 알 방법이 없다 — 지금 고른 사이트를 적으면 **그 zip 이 그 사이트 것이라고
      //    우리가 말해 주는 셈**이 된다. 그래서 문면 정본(`say`)에도 두지 않는다: 그 객체의 계약이
      //    「전부 사이트를 말한다」이고 시험이 그것을 전수로 문다.
      ours(`지금 열어 두신 ${plainNotice(plan.dir, 120)} 에 이 zip 을 풉니다.`),
      HERE,
      "다른 폴더 고르기…",
    );
    if (answer === undefined) return undefined;
    if (answer === HERE) return plan.dir;
  }
  // ⚠ **사이트를 아는 흐름에서만 옆자리를 제안한다.** 위 `here` 갈래의 주석이 「사이트 이름을
  //    적지 않는다」고 적은 것은 **맨몸 명령** 얘기다 — 그 문은 zip 이 어느 사이트 것인지 알
  //    방법이 없다. 여기 `pinned` 는 zip 의 주장이 아니라 **사람이 방금 고른 사이트**라, 이름이
  //    있어야 어디에 무엇이 생기는지 말할 수 있다. 형제 받기의 옆자리 제안과 같은 규율이고,
  //    「빈 폴더를 새로 만들어 고르세요」가 비개발자를 멈춰 세우던 그 자리를 없앤다.
  if (plan.kind === "sibling" && pinned !== undefined && openDir !== undefined) {
    const free = suggestSiteSibling(openDir, pinned);
    if (free !== null) {
      const NEW = "옆에 새 폴더로 풀기";
      const answer = await vscode.window.showInformationMessage(
        ours(say.importTargetSibling(pinned, free)),
        NEW,
        "다른 폴더 고르기…",
      );
      if (answer === undefined) return undefined;
      if (answer === NEW) {
        try {
          // `recursive: false` — 이미 있으면 던진다. **덮어쓰기로 흘러가지 않는다**(받기와 같다).
          await mkdir(free, {recursive: false});
          return free;
        } catch (error) {
          log(
            `옆에 폴더를 만들지 못했습니다(${error instanceof Error ? error.message : error}) — 직접 골라 주세요.`,
          );
        }
      }
    }
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "여기에 풀기",
    defaultUri: openDir ? vscode.Uri.file(dirname(openDir)) : undefined,
    title: "소스를 풀 빈 폴더를 고르세요",
  });
  return picked?.[0]?.fsPath;
}

/**
 * 옆에 만들 폴더 이름을 **사이트 코드**로 짓는다. 받기의 [suggestSibling] 과 갈라 두는 이유는
 * 이름의 뜻이 다르기 때문이다 — 받기는 판 번호를 알아 `이름-v판` 이고, zip 은 판을 모르므로
 * 사이트 코드가 유일하게 뜻 있는 이름이다.
 *
 * ⚠ 이름은 **서버 값에서 그대로 짓지 않는다** — 사이트 코드는 서버 목록에서 오므로
 *   `safeFileName` 을 지난 것만 쓴다(형제 팩·zip 저장 이름과 같은 규율).
 */
function suggestSiteSibling(
  openDir: string,
  tenant: CapturedTenant,
): string | null {
  const parent = dirname(openDir);
  const base = safeFileName(String(tenant), "site");
  const free = nextAvailableName(base, (name) => existsSync(join(parent, name)));
  return free === null ? null : join(parent, free);
}

/**
 * 푼 폴더를 **고른 사이트에 붙인다** — 받기(`openSite`)가 하는 세 쓰기와 같은 자리다.
 * 신뢰 근거는 zip 의 주장이 아니라 **사람이 방금 고른 선택**이라, 「zip 의 출처 표시를 소속으로
 * 승격하지 않는다」는 규율과 충돌하지 않는다.
 *
 * ⚠ **소속을 바꾸지 않는다.** 이미 다른 사이트에 붙은 폴더에는 안 쓴다 — 소속을 **바꾸는** 동사는
 *   「사이트에 연결」 하나로 남긴다(`decidePickedFolder` 가 세운 규율). 빈 폴더 강제가 `.vscode` 를
 *   통과시키므로(`emptyDir.ts` 의 IGNORED), 링크만 가진 폴더가 실제로 여기까지 온다.
 *
 * ⚠ **표식은 `linked` 다**(판 주장 없음). 받기의 `fetched` 는 판 번호·sha 를 주장하는데 zip 은
 *   그 둘을 모른다 — 모르는 것을 적으면 그 표식이 거짓이 된다.
 */
async function bindImportedFolder(
  target: string,
  tenant: CapturedTenant,
  plan: ImportBinding,
): Promise<boolean> {
  if (plan.kind === "keep") {
    log(
      `고르신 폴더는 이미 ${plainNotice(plan.bound, 64)} 에 연결돼 있어 소속을 바꾸지 않았습니다 — 「사이트에 연결」로 정해 주세요.`,
    );
    return false;
  }
  if (plan.kind === "unknown") {
    // 「못 읽었다」는 「없다」가 아니다 — 모르는 폴더를 우리 값으로 덮지 않는다.
    log(
      "고르신 폴더의 `.vscode/settings.json` 을 읽지 못해 소속을 적지 않았습니다 — 「사이트에 연결」로 정해 주세요.",
    );
    return false;
  }
  await markFolderLinked(target, String(tenant));
  await linkFolderToSite(target, tenant);
  rememberFolder(String(tenant), target);
  return true;
}

/**
 * 「zip 으로 시작」 — **남이 준 소스 zip** 을 빈 폴더에 푼다.
 *
 * 「예제 zip 다운로드」로 받은 팩도 이 문으로 들어온다. 다만 출처가 다르다: 서버 팩은 원장이 sha256 을 주장하고 우리가
 * 대조하는데, **로컬 파일에는 주장할 원장이 없다.** 그래서 무결성 검증을 흉내 내지 않는다 —
 * 대신 `decideImportPlan` 이 **쓰기 전에** 구조를 판정하고, 통과 못 하면 파일을 하나도 안 만든다.
 * 완료 문면도 「검증됐다」고 말하지 않는다.
 */
async function importZipCommand(pinned?: CapturedTenant): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {"사이트 소스": ["zip"]},
    openLabel: "이 zip 으로 시작",
    title: "받으신 사이트 소스 zip 을 고르세요",
  });
  const zipPath = chosen?.[0]?.fsPath;
  if (!zipPath) return;

  // ⚠ **읽기·판정은 한 문을 지난다**(`readZipWithPlan`) — 시작과 갱신이 각자 판정을 들면
  //    한쪽만 고쳐진다. 여기서 미리 읽는 것은 출처 대조를 **풀기 전에** 하기 위해서다.
  //
  // ⚠ **읽는 동안 화면이 조용하면 안 된다**(성능 심의 🟡). 이 읽기는 종전에 진행 알림 «안»에
  //    있었는데 앞으로 나오면서 표시를 잃었다 — 큰 zip 을 느린 매체에서 읽으면 zip 을 고른 뒤
  //    다음 물음까지 몇 초가 비고, 그 침묵은 멈춘 것으로 읽힌다.
  //    **상태 표시줄에 낸다**(`Window`) — 전형 zip 은 1초 안에 끝나므로 알림으로 내면 깜박임만
  //    남는다. 알림 자리는 실제로 오래 도는 해제가 쓴다.
  const {zip, plan} = await vscode.window.withProgress(
    {location: vscode.ProgressLocation.Window, title: "zip 을 읽는 중"},
    () => readZipWithPlan(zipPath),
  );

  // ⚠ **출처가 다르면 말하고, 막지는 않는다.** 표시는 서명 없는 선언이지 증명이 아니고, 대행사가
  //    다른 이름으로 내보낸 팩을 쓰는 것이 정상 흐름이다(`judgeUpdate` 와 같은 규율). 다만 이
  //    흐름은 폴더를 그 사이트에 **붙이므로**, 어긋남을 조용히 넘기면 그 폴더가 남의 소스를 담은
  //    채 이 사이트 것이라고 주장하게 된다 — 그래서 클릭 자체가 고지된 진술이 되게 한다.
  if (pinned !== undefined) {
    const prov = await readProvenance(zip, plan);
    const zipTenant = prov?.tenant ?? null;
    if (zipTenant !== null && zipTenant !== String(pinned)) {
      const GO = "알고 계속";
      log(`zip 출처 표시(${zipTenant})가 고르신 사이트(${String(pinned)})와 다릅니다.`);
      const answer = await vscode.window.showWarningMessage(
        ours(say.importProvenanceMismatch(pinned, zipTenant)),
        GO,
      );
      if (answer !== GO) return;
    }
  }

  const target = await chooseImportTarget(pinned);
  if (!target) return;

  // 붙일지 말지는 **풀기 전 상태**로 정한다. 지금은 `EXCLUDED_PATHS` 가 표식을 계획 단계에서
  // 떨구므로 zip 이 실어 온 표식이 디스크에 닿지 않지만, 그 목록이 무너져도 소속 판정은
  // 안 뒤집히게 둔다 — 판정의 재료를 **우리가 아는 시점**에서 뜨는 것이 요점이다.
  //
  // ⚠ **판정은 core 가 한다**(`decideImportBinding`). 확장 안 조건문으로 두면 「못 읽었다」를
  //    「없다」로 접어도 시험이 못 문다 — 실제로 그 접힘이 이 가드를 열어 뒀다(보안 심의 🟠).
  const bindPlan =
    pinned === undefined
      ? null
      : decideImportBinding(
          readSourceMarkAt(target),
          workspaceLinkState(target),
          String(pinned),
        );

  // ⚠ **가드는 여기서부터다** — 형제 받기와 같은 규율이다. zip 고르기·풀 자리 묻기를 덮으면
  //    답 없는 물음 하나가 창이 죽을 때까지 나머지를 막는다(`whileExtracting`).
  const result = await whileExtracting(() =>
    vscode.window.withProgress(
      {location: vscode.ProgressLocation.Notification, title: "사이트 소스를 푸는 중"},
      () => importZipInto(zip, plan, target),
    ),
  );
  if (result === BUSY) return;

  log(`파일 ${count(result.fileCount)}개를 풀었습니다: ${target}`);
  if (result.dropped.length > 0) {
    // **무엇이 빠졌는지 말한다.** 조용히 빼면 「보낸 파일이 없다」는 문의가 우리에게 온다.
    log(`정본에 싣지 않는 ${count(result.dropped.length)}개는 빼고 풀었습니다: ${result.dropped.join(", ")}`);
  }
  // ⓒ 붙이기 — 사이트를 아는 흐름에서만. 사이드바 갱신 **앞**이다: 붙인 결과가 화면에 보여야 한다.
  const bound =
    pinned !== undefined && bindPlan !== null && (await bindImportedFolder(target, pinned, bindPlan));
  await refreshSidebar();

  // ⚠ **푼 곳이 지금 열린 폴더 자신일 수 있다.** 그때 「폴더 열기」는 이미 열려 있는 것을 다시
  //    여는 죽은 단추이고, 「폴더를 열고」라는 안내도 할 일이 없는 말이 된다.
  if (target === workspaceDir()) {
    void vscode.window.showInformationMessage(
      bound && pinned !== undefined
        ? ours(say.importedFor(pinned))
        : ours("사이트 소스를 이 폴더에 풀었습니다. 「사이트에 연결」로 사이트에 붙이면 미리보기·올리기가 됩니다."),
    );
    return;
  }
  // ⚠ **붙인 폴더에 「사이트에 연결」을 다시 시키지 않는다.** 그 문장은 할 일이 없는 말이고,
  //    비개발자는 시키는 대로 하다가 「왜 또 고르지」에서 멈춘다.
  const open = await vscode.window.showInformationMessage(
    bound && pinned !== undefined
      ? ours(say.importedFor(pinned))
      : ours("사이트 소스를 풀었습니다. 폴더를 열고 「사이트에 연결」로 사이트에 붙이면 미리보기·올리기가 됩니다."),
    "폴더 열기",
  );
  if (open === "폴더 열기") {
    // ⚠ **여기도 `openSiteFolder` 를 지난다.** 직접 열면 미리보기가 돌고 있어도 무경고로
    //    지금 창을 뺏는다 — 받기·전환 흐름이 이미 고친 그 비대칭이 여기서 되살아난다.
    await openSiteFolder(target);
  }
}

/**
 * 읽기·판정·해제. **판정은 core 가 한다** — 확장 안에 두면 시험도 검사기도 못 닿는다.
 *
 * zip 을 읽고 **판정까지** 한 자리에서 한다.
 *
 * ⚠ **부르는 쪽에서 각자 판정하지 마라.** 시작·갱신 둘이 같은 판정을 따로 들면 한쪽만 고쳐진다 —
 *   `check-wiring` 이 그 형태를 반려하는 이유이고, 이 레포가 이미 반복해 밟은 자리다.
 */
async function readZipWithPlan(zipPath: string): Promise<{zip: Buffer; plan: ImportPlan}> {
  const zip = await readZipFile(zipPath);
  return {zip, plan: decideImportPlan(listZipEntries(zip))};
}

/**
 * ⚠ **읽은 zip 과 계획을 받는다 — 여기서 다시 읽지 않는다.** 부르는 쪽이 이미 `readZipWithPlan`
 *   으로 읽고 그 계획으로 출처를 대조했다. 여기서 또 읽으면 **대조한 바이트와 푸는 바이트가
 *   다를 수 있다**(그 사이 파일이 바뀌면 그렇다) — 고지한 것과 실제가 갈리는 자리가 된다.
 */
async function importZipInto(
  zip: Buffer,
  plan: ImportPlan,
  targetDir: string,
): Promise<{fileCount: number; dropped: string[]}> {
  // ⚠ **빈 폴더 강제는 해제기 밖이다**(형제 `fetchSiteSource` 와 같은 규율) — 있는 파일을
  //    덮어쓰지 않는다. `meaningfulEntries` 가 편집기·OS 부스러기는 「비어 있음」으로 본다.
  await mkdir(targetDir, {recursive: true});
  if ((await meaningfulEntries(targetDir)).length > 0) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "고르신 폴더가 비어 있지 않습니다.",
      "빈 폴더를 골라 주세요(있는 파일을 덮어쓰지 않습니다).",
    );
  }
  // ⚠ **반쪽 해제를 남기지 않는다** — 형제 `fetchSource` 와 같은 규율이다.
  //    `extractZip` 은 항목을 훑으며 그때그때 쓰므로, 도중에 던지면 앞서 쓴 파일이 남는다.
  //    그러면 ⑴ 배송 문서의 「아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다」가 거짓이 되고
  //    ⑵ 재시도가 「비어 있지 않습니다」로 막혀 손으로 지우기 전에는 못 빠져나온다.
  //    적대적 zip 이 보안 정지를 유발하고도 디스크에 흔적을 남기는 것도 이 자리다.
  const before = await snapshotEntries(targetDir);
  let fileCount: number;
  try {
    ({fileCount} = await extractZip(zip, targetDir, plan));
  } catch (cause) {
    await removeAdded(targetDir, before);
    throw cause;
  }
  return {fileCount, dropped: plan.dropped};
}


/**
 * zip 안의 **출처 표시**를 읽는다. 없거나 못 읽으면 `null`(= 모른다).
 *
 * ⚠ **저수준 판독기를 새로 쓰지 않는다.** `extractZip` 은 읽기 «전에» 범위·이름 바이트·항목 수
 *   상한을 건다. 같은 일을 하는 문이 둘이 되면 한쪽만 고쳐진다 — 이 레포가 반복해 밟은 형태다.
 *   그래서 **이미 만든 계획을 그대로 태우고** 허락 목록만 그 한 항목으로 좁혀 임시 자리에 푼다.
 */
async function readProvenance(zip: Buffer, plan: ImportPlan): Promise<ReturnType<typeof parseProvenance>> {
  const box = await mkdtemp(join(tmpdir(), "zalkera-prov-"));
  try {
    await extractZip(zip, box, {...plan, keep: [PROVENANCE_PATH], dropped: []});
    return parseProvenance(readSmallOwnFile(join(box, PROVENANCE_PATH)));
  } catch {
    // 못 읽은 것은 «모른다»다 — 여기서 갱신을 막지 않는다(경고만 하는 게이트다).
    return null;
  } finally {
    await rm(box, {recursive: true, force: true});
  }
}

/** 판정별로 사람이 읽는 줄과 버튼 문구. **match 와 unknown 이 서로 부분문자열이면 안 된다.** */
function provenanceNotice(verdict: UpdateVerdict, zipTenant: string | null, binding: string | null) {
  switch (verdict) {
    case "match":
      // ⚠ 「검증됨」이라 쓰지 않는다 — 표시는 서명 없는 **선언**이지 증명이 아니다.
      return {line: `출처 표시: 이 사이트(${plainNotice(binding ?? "", 64)})에서 내보낸 소스로 표시되어 있습니다.`, action: "갈아 끼우기"};
    case "mismatch":
      // 버튼 문구를 바꿔 **클릭 자체가 고지된 진술**이 되게 한다. 막지는 않는다.
      return {
        line: `⚠ 이 zip 은 다른 사이트(${plainNotice(zipTenant ?? "", 64)})에서 내보낸 것으로 표시되어 있습니다. 이 폴더의 사이트: ${plainNotice(binding ?? "", 64)}.`,
        action: "다른 사이트 표시를 알고 갈아 끼우기",
      };
    case "unbound":
      return {
        line: zipTenant === null ? "이 폴더는 아직 사이트에 연결되어 있지 않습니다." : `이 zip 은 ${plainNotice(zipTenant, 64)} 사이트에서 내보낸 것으로 표시되어 있습니다. 이 폴더는 아직 어느 사이트에도 연결되어 있지 않습니다.`,
        action: "갈아 끼우기",
      };
    default:
      return {
        line: `출처 표시 없거나 읽을 수 없음 — 이 zip 이 어느 사이트의 것인지 도구는 알 수 없습니다. 이 폴더의 사이트: ${plainNotice(binding ?? "", 64)}. 파일 이름과 보낸 곳으로 확인해 주세요.`,
        action: "갈아 끼우기",
      };
  }
}

/**
 * **받은 zip 으로 지금 폴더를 갈아 끼운다.**
 *
 * 대행사가 새 판을 보내오는 것은 예외가 아니라 정상 흐름인데, `zip 으로 시작`은 빈 폴더만
 * 받으므로 갱신하려면 사람이 손으로 폴더를 비워야 했다. 그 조작에 함정이 둘이다 —
 * `rm -rf 폴더/*` 는 dot 파일(`.gitignore`·`.github/`·`.zalkera/`)을 하나도 못 지워 다음 시도가
 * 「비어 있지 않습니다」로 막히고, 중간에 실패하면 되돌릴 길이 없다.
 *
 * 그래서 옆에 치워 두고 채운 뒤 성공했을 때만 버린다(`replaceContents`). 그리고 **소속 표식은
 * 보존한다** — 포장기가 `.zalkera/source.json` 을 빼고 압축하므로 zip 에 그 파일이 없다. 그냥 풀면
 * 이 폴더가 어느 사이트 것인지 잃는다.
 */
async function updateZipCommand(): Promise<void> {
  const dir = siteDir();
  if (dir === null) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "지금 창에 사이트 소스가 열려 있지 않습니다.",
      "갈아 끼울 폴더를 먼저 여세요 — 새로 시작하는 것이면 「zip 으로 시작」입니다.",
    );
  }

  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {"사이트 소스": ["zip"]},
    openLabel: "이 zip 으로 갈아 끼우기",
    title: "새로 받으신 사이트 소스 zip 을 고르세요",
  });
  const zipPath = chosen?.[0]?.fsPath;
  if (!zipPath) return;

  // ⚠ **되돌릴 수 없는 조작이라 한 번 묻는다.** 실패하면 되돌리지만, 성공하면 옛 소스는 없다.
  // ⚠ **읽기·판정을 확인 «앞»에 둔다.** 사람이 동의할 때 이미 「이 zip 이 어느 사이트 것으로
  //    표시돼 있는가」를 알고 있어야 한다 — 되돌릴 수 없는 조작의 동의는 그 재료 위에서 받는다.
  const {zip, plan} = await readZipWithPlan(zipPath);
  const prov = await readProvenance(zip, plan);
  // ⚠ **소속이 없으면 «고른 사이트»와 견준다.** 소속 없는 폴더에서 올리면 그 사이트가 소속이
  //    되므로(발행이 표식을 만든다), 비교를 건너뛰면 「D 를 골라 두고 C 의 zip 을 넣는」 경로가
  //    무경고로 통과한다 — 이 게이트가 막으려는 그 사고다(심의 실측).
  const binding = currentFolderBinding() ?? tenantCode() ?? null;
  const verdict = judgeUpdate(prov, binding);
  const provNotice = provenanceNotice(verdict, prov?.tenant ?? null, binding);

  // ⚠ **무엇을 남기는지 계산해서 보여 준다.** 목록은 포장기가 zip 에서 빼는 것과 같은 술어로
  //    고른다(`keepNames`) — 손으로 열거하면 두 목록이 갈리고, 갈린 쪽이 영구 삭제된다.
  const keep = await keepNames(dir);
  const ok = await vscode.window.showWarningMessage(
    ours("이 폴더의 소스를 고르신 zip 으로 갈아 끼웁니다. 지금 내용은 사라집니다."),
    {
      modal: true,
      // ⚠ **셋 다 소독을 지난다.** 보간 셋이 무표기·무소독이었다 — `dir` 과 `keep` 은 **디스크
      //    이름**이라 남이 정할 수 있고, 개행 하나로 뒷줄(「그대로 두는 것: …」)을 위조할 수
      //    있다. 형제 발행 모달과 같은 자를 댄다(보안 심의).
      detail:
        `${plainNotice(provNotice.line, 512)}\n\n${plainNotice(dir, 512)}\n\n` +
        `그대로 두는 것: ${keep.length > 0 ? plainNotice(keep.join(" · "), 512) : "없습니다"}`,
    },
    provNotice.action,
  );
  if (ok !== provNotice.action) return;

  // ⚠ **먼저 멈춘다.** 미리보기가 파일을 물고 있으면 지우기가 실패하고, 그 실패는 갈아 끼우기
  //    한복판에서 난다 — 되돌리기가 도는 자리지만 애초에 거기까지 안 가는 편이 낫다.
  await stopPreview();

  // ⚠ **가드는 여기서부터다** — 형제 둘과 같은 규율이다(`whileExtracting`). 확인 창까지 덮으면
  //    사람이 답을 미룬 그 시간 내내 나머지가 막힌다.
  //
  // 여기서 [BUSY] 로 물러나면 **미리보기는 이미 멈춘 뒤다.** 그 순서를 바꾸지 않는다 — 멈추는
  // 것은 위 주석이 적은 이유로 해제 «앞»이어야 하고, 되돌릴 수 없는 것은 폴더뿐인데 그쪽은
  // 아무것도 안 건드렸다. 다시 눌러 주시면 된다.
  const result = await whileExtracting(() =>
    vscode.window.withProgress(
      {location: vscode.ProgressLocation.Notification, title: "사이트 소스를 갈아 끼우는 중"},
      async () => {
        let fileCount = 0;
        const {preserved, kept} = await replaceContents(dir, [SOURCE_MARK_PATH], keep, async () => {
          ({fileCount} = await extractZip(zip, dir, plan));
        });
        return {fileCount, preserved, kept};
      },
    ),
  );
  if (result === BUSY) return;

  log(`파일 ${count(result.fileCount)}개로 갈아 끼웠습니다: ${dir}`);
  if (plan.dropped.length > 0) {
    log(`정본에 싣지 않는 ${count(plan.dropped.length)}개는 빼고 풀었습니다: ${plan.dropped.join(", ")}`);
  }
  if (result.kept.length > 0) {
    log(`그대로 둔 ${count(result.kept.length)}개: ${result.kept.join(", ")}`);
  }
  if (result.preserved.length === 0) {
    // 표식이 없었다는 것은 이 폴더가 아직 사이트에 안 붙었다는 뜻이다 — 조용히 넘기지 않는다.
    log("이 폴더에는 사이트 소속 표식이 없었습니다 — 「사이트에 연결」로 붙이면 미리보기·올리기가 됩니다.");
  }
  await refreshSidebar();

  await vscode.window.showInformationMessage(
    ours("소스를 갈아 끼웠습니다. 「미리보기 시작」으로 확인한 뒤 「새 버전 배포」로 올리세요."),
  );
}

/**
 * 잔재를 찾으면 말한다 — 창이 열릴 때마다, 치울 때까지.
 *
 * ⚠ **`say` 가 아니다.** 그 모듈은 **사이트** 문면의 자리이고 「전부 사이트 이름을 담는다」가
 *   그 요점인데, 이 알림은 **폴더** 이야기다 — 경로가 이미 모호하지 않아 사이트 이름은 장식이고,
 *   그 장식을 위해 `captureTenant` 자리를 하나 더 여는 것은 브랜드의 뜻을 흐린다(그 함수는 값이
 *   **API 에 묶이는 순간**을 표시한다 — 여기엔 API 가 없다). 형제 `warnProtectedPath` 와 같은 층이다.
 *
 * ⚠ **지워 주지 않는다.** 그 폴더는 **원본의 유일한 사본일 수 있다**(중단 시점에 따라 소스 폴더
 *   쪽이 반쪽이다). 어디 있는지 말하고 사람이 한다.
 */
async function announceStashLeftovers(): Promise<void> {
  // ⚠ **`siteDir()` 이 아니라 `workspaceDir()` 이다 — 이 차이가 곧 이 알림의 존재 이유다.**
  //    `siteDir()` 은 `package.json` 이 있어야 참인데, 교체가 **일찍** 죽으면(치우기는 끝나고
  //    해제는 시작 전) 그 파일이 **스태시 안**에 있다. 즉 알림이 가장 필요한 최악 사례에서
  //    정확히 침묵한다 — 그리고 배송 문서는 「그런 폴더가 있으면 창을 열 때 알려 드립니다」라고
  //    **무조건**으로 약속한다. 그 약속을 지키려면 소스 여부를 안 물어야 한다(3축 심의 F1).
  const dir = workspaceDir();
  if (dir === undefined) return;
  const found = await siblingStashes(dir);
  if (found.length === 0) return;
  // ⚠ **이름만 말하면 못 찾는다.** 숨은 dot 폴더라 탐색기 기본 설정에서는 안 보인다 — 전체
  //    경로를 주고, 여는 단추까지 준다(설계 §5).
  const open = "폴더 열기";
  const answer = await vscode.window.showWarningMessage(
    ours("지난 갈아 끼우기가 중간에 끊긴 흔적이 있습니다: ") +
      plainNotice(found.map((n) => join(dirname(dir), n)).join(" · "), 512) +
      ours(" — 원래 소스가 그 안에 있을 수 있습니다. 옮기실 것을 옮기신 뒤 그 폴더를 지우시면 됩니다."),
    open,
  );
  if (answer !== open || found[0] === undefined) return;
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(join(dirname(dir), found[0])));
}

/**
 * 이 소스 폴더의 **형제들** 중 지난 갈아 끼우기가 남긴 것.
 *
 * ⚠ **판정은 core 가 한다**(`stashLeftovers`) — 확장 안에 접두를 또 적으면 만드는 쪽과 갈리고,
 *   갈린 날 감지기가 **영원히 조용히 빈손**이 된다.
 *
 * 못 읽으면 **빈 목록**이다 — 부모 폴더를 못 읽는 것으로 갈아 끼우기를 막지 않는다(모른다로 막지
 * 않는다). 그 대가는 「말해 줄 수 있었는데 안 한 것」 하나뿐이다.
 */
async function siblingStashes(dir: string): Promise<string[]> {
  try {
    const real = await realpath(dir);
    return stashLeftovers(await readdir(dirname(real)));
  } catch {
    return [];
  }
}

/**
 * **「서버 판으로 교체」** — 이 폴더를 서버 정본으로 갈아 끼운다.
 *
 * ■ 왜 「소스 zip 다운로드 → zip 으로 교체」로 대신하지 않나 — **결과가 틀린다**
 *   zip 은 표식을 안 싣고 「zip 으로 교체」는 옛 표식을 되살린다. 그래서 두 걸음으로 맞추면
 *   **표식이 옛 판을 선언한 채** 남고, 다음 발행마다 「남이 올린 판이 있습니다」 동의가 뜬다 —
 *   자기가 방금 받아 온 그 판을 두고. 조합으로는 원리상 못 고친다(zip 문은 판 번호를 모른다).
 *
 * ■ **네트워크 먼저, 파괴는 나중**
 *   `refreshSiteSource` 가 전송·sha 대조를 마친 **뒤에야** 폴더를 비운다. 그래서 받는 동안 창을
 *   닫으면 **폴더는 그대로 남는다.** 이 문에도 전송 취소 손잡이는 없지만(형제 받기와 같은 한계)
 *   순서가 이미 안전한 쪽이라 그 부재의 대가가 작다.
 */
async function updateFromServerCommand(): Promise<void> {
  const dir = siteDir();
  if (dir === null) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "지금 창에 사이트 소스가 열려 있지 않습니다.",
      "갈아 끼울 폴더를 먼저 여세요 — 새로 시작하는 것이면 「소스 다운로드」입니다.",
    );
  }
  const {api, tenant} = await ensureApiFor();

  // ⚠ **판을 여기서 고른다 — 받기 셋과 «같은 재료로».** 판정 함수만 같고 목록이 다르면 「소스
  //    다운로드가 준 것과 이 문이 준 것이 다른」 날이 온다. 형제 셋이 전량을 읽으므로 여기도
  //    전량이다 — 페이지를 걸면 활성 판이 그 밖으로 밀린 사이트에서 **다른 판을 갈아 끼운다.**
  const revisions = await api.listRevisions();
  const picked = pickRevision(revisions);
  if (picked === null) throw noRevisionError(revisions);
  // ⚠ **켜져 있는 판이 아닐 때는 말한다.** 사이드바 툴팁이 「서버에 **켜져 있는** 판」이라고
  //    적어 두었으므로, 폴백으로 최신 READY 를 잡은 칸에서 침묵하면 **파괴 동사가 켜져 있지도
  //    않은 판을 무표기로 받는** 형상이 된다(3축 심의 F2). 형제 받기와 같은 문면을 쓴다.
  if (picked.why === "latest-ready") log(say.pickedLatestReady(tenant, picked.revisionNo));

  // ⚠ **되돌릴 수 없는 조작이라 재료를 «확인 앞»에 모은다.** 사람이 동의할 때 「어느 판에서
  //    어느 판으로」·「무엇이 남는가」·「지난 잔재가 있는가」를 이미 알고 있어야 한다.
  const keep = await keepNames(dir);
  const from = declaredBaseRevisionNo(readSourceMarkAt(dir), String(tenant));
  const leftovers = await siblingStashes(dir);
  const ask = say.serverReplaceConfirm(tenant, picked.revisionNo, dir, from, keep, leftovers);
  const answer = await vscode.window.showWarningMessage(
    ask.message,
    {modal: true, detail: ask.detail},
    ask.action,
    ask.exportFirst,
  );
  if (answer === ask.exportFirst) {
    // ⚠ **이어 붙이지 않는다.** 내보내기를 부르고 여기서 끝낸다 — 「내보낸 뒤 자동으로 교체」는
    //    사람이 저장 대화상자를 취소했을 때 무엇을 할지부터 갈리는 상태기계다. 다시 누르면 된다.
    await vscode.commands.executeCommand("zalkera.export");
    return;
  }
  if (answer !== ask.action) return;

  // ⚠ **먼저 멈춘다.** 미리보기가 파일을 물고 있으면 지우기가 실패하고, 그 실패는 갈아 끼우기
  //    한복판에서 난다 — 형제 `updateZipCommand` 와 같은 순서다.
  await stopPreview();

  const result = await whileExtracting(() =>
    vscode.window.withProgress(
      {location: vscode.ProgressLocation.Notification, title: "서버 판으로 갈아 끼우는 중"},
      () =>
        refreshSiteSource({
          api,
          targetDir: dir,
          tenant: String(tenant),
          link: workspaceLinkState(dir),
          revisionNo: picked.revisionNo,
          onProgress: log,
        }),
    ),
  );
  if (result === BUSY) return;

  log(`파일 ${count(result.fileCount)}개로 갈아 끼웠습니다: ${dir}`);
  if (result.kept.length > 0) log(`그대로 둔 ${count(result.kept.length)}개: ${result.kept.join(", ")}`);
  // ⚠ **표식을 못 쓴 것을 로그에만 남기지 않는다.** 아래 알림이 그 사실을 사람에게 말한다 —
  //    다음 발행에서 뜰 동의 창의 «이유»가 여기 있기 때문이다.
  if (!result.mark.written) log(`버전 표시를 갱신하지 못했습니다(${result.mark.reason}).`);
  await refreshSidebar();

  await vscode.window.showInformationMessage(
    say.serverReplaced(tenant, result.revisionNo, result.mark.written),
  );
}

/**
 * 조회 하나에 **화면을 안 붙드는 시한**을 씌운다. 시한을 넘기면 거절한다 — 부르는 쪽이 이미
 * 「못 읽으면 강하」를 갖고 있으므로 그 자리로 수렴한다.
 *
 * ⚠ **이긴 쪽이 정해지면 타이머를 지운다** — 안 지우면 그만큼 살아 있다(형제 `probeFetchable`
 *   의 KDoc 이 세운 규율).
 */
function withProbeDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`조회가 ${FETCHABLE_PROBE_MS}ms 안에 안 끝났습니다`)),
      FETCHABLE_PROBE_MS,
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * D4「버전 전환」 — **어느 판을 켤지 고른다.** 뒤로 가는 것은 그중 한 경우일 뿐이라 이름이
 * 방향을 가리키지 않는다(오너 확정). 롤백한 뒤 다시 앞 판으로 오는 길도 여기 하나다.
 *
 * ■ 확인을 modal 로 받는다
 *   전환은 **방문자가 보는 화면이 즉시 바뀌는** 동작이다. 잘못 누르면 손님이 다른 화면을 본다.
 *   「새 버전 배포」도 modal 로 묻는다 — 둘 다 배포 사건이라 문의 무게가 같아야 한다.
 */
async function switchVersion(): Promise<void> {
  const { api, tenant } = await ensureApiFor();
  // ⚠ **되돌리기 대상은 서버가 답한다** — 화면이 `isActive` 로 지어내면 활성 포인터 없는
  //    테넌트에서 그 판이 후보로 떠, 고르는 순간 전환이 아니라 **폐기**가 된다(백엔드 응답
  //    KDoc 이 「화면이 `isActive` 로 직접 찾으면 안 된다」고 적어 뒀고 콘솔이 먼저 밟았다).
  //
  // ⚠ **못 읽으면 막지 않는다.** 구서버·권한 부족·망 단절이면 `null` 로 강하하고 그때 동작은
  //    종전과 같다 — 「모르는 것으로는 막지 않는다」.
  const [revisions, revertTarget] = await Promise.all([
    api.listRevisions(),
    // ⚠ **이 조회가 화면을 붙들지 않게 시한을 건다.** 「못 읽으면 막지 않는다」가 이 자리의
    //    약속인데, `.then(성공, 실패)` 는 **거절에만** 강하한다 — 응답을 삼키는 프록시·먹통
    //    게이트웨이는 거절하지 않고 제어 평면 상한까지 매단다. 실측으로, 그러면 「버전 전환」
    //    목록이 **30초 동안 아무 표시 없이** 안 떴다(성능 심의).
    //
    //    형제 `probeFetchable` 이 같은 이유로 같은 상수를 쓴다. 시한에 걸리면 되돌리기 대상이
    //    목록에 남지만, 그 뒤를 **이 판이 만든 동의 모달**이 받는다 — 오류 경로에서 이미
    //    받아들인 자세와 같고, 파괴적 결과 앞에 문이 하나 더 있다.
    withProbeDeadline(api.draftState()).then(
      // ⚠ **응답 몸통과 필드 둘 다 안 믿는다.** `request()` 는 봉투에 `data` 키가 **있는지**만
      //    보므로 `{"data": null}` 이 그대로 통과해 `d === null` 이 된다 — 그러면 여기서 원시
      //    `TypeError` 가 나고, `.then(성공, 실패)` 의 둘째 인자는 **첫째가 던진 것을 안 잡는다.**
      //    결과는 「버전 전환」이 통째로 막히고 고객이 원시 오류 문면을 보는 것 — 바로 아래
      //    배선이 「모르는 것으로 막는 형상」이라며 막겠다고 선언한 그 피해다(보안 심의 🟠).
      //
      // ⚠ **형도 안 믿는다.** 이 번호와 목록의 번호는 **다른 엔드포인트**에서 온다 — 한쪽이
      //    문자열로 직렬화되면 `!==` 가 늘 참이 되어 제외 가드가 통째로 무력화된다.
      //    읽는 자리에서 정규화한다(`count()` 가 세운 잣대와 같다).
      (d) => (typeof d?.revertTargetRevisionNo === "number" ? d.revertTargetRevisionNo : null),
      (error) => {
        log(`되돌리기 대상을 확인하지 못했습니다 — ${error instanceof Error ? error.message : error}`);
        return null;
      },
    ),
  ]);
  // **켤 수 있는 것만 고르게 한다.** BUILDING·FAILED 를 목록에 넣으면 골랐다가 409 로 거절당한다 —
  // 고를 수 없는 것을 보여 주고 거절하는 것은 화면이 사람에게 거짓말을 하는 것이다.
  //
  // ⚠ **켜진 판을 목록에서 빼는 것은 취향이 아니라 방어다.** 백엔드의 `activate` 는 이미 활성인
  //    번호를 받으면 전환이 아니라 「지금으로 되돌리기」로 갈라져 **편집 중인 파일과 게시 대기 AI
  //    변경을 버린다.** 이 필터가 그 문 앞을 막고 있다 — 걷어내면 롤백 목록에서 지금 판을 골랐다가
  //    작업이 사라진다.
  const candidates = switchCandidates(revisions, revertTarget);
  if (candidates.length === 0) {
    const building = revisions.filter((r) => r.status === "BUILDING").length;
    void vscode.window.showInformationMessage(
      building > 0
        ? `지금 바꿀 수 있는 버전이 없습니다(빌드 중 ${count(building)}개). 끝나면 다시 보십시오.`
        : "지금 켤 수 있는 다른 판이 없습니다.",
    );
    return;
  }

  // 목록은 최신순이다. 맨 위가 대개 **방금 올린 것**이라 그렇다고 말해 준다 — 사람이 번호를
  // 외우고 있지는 않다.
  const active = revisions.find((r) => r.isActive);

  const choice = await vscode.window.showQuickPick(
    candidates.map((r, index) => ({
      label: `버전 ${r.revisionNo}`,
      description: r.label
        ? `${plainNotice(r.label, 60)} · ${revisionWhen(r.createdAt)}`
        : revisionWhen(r.createdAt),
      detail:
        index === 0 && (active === undefined || r.revisionNo > active.revisionNo)
          ? `${r.status} · 가장 최근에 올린 것`
          : r.status,
    })),
    {
      title: active
        ? `지금은 버전 ${active.revisionNo} 입니다 — 어느 버전으로 바꿀까요?`
        : "어느 버전으로 바꿀까요?",
    },
  );
  const target = candidates.find(
    (r) => `버전 ${r.revisionNo}` === choice?.label,
  );
  if (!target) return;

  const ask = say.switchConfirm(tenant, target.revisionNo);
  const confirm = await vscode.window.showWarningMessage(
    ask.message,
    { modal: true, detail: ask.detail },
    ask.action,
  );
  if (confirm !== ask.action) return;

  const activate = (discardPendingChanges: boolean): Thenable<ActivateResult> =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `버전 ${countJosa(target.revisionNo, "으로/로")} 바꾸는 중`,
      },
      () => api.activateRevision(target.revisionNo, discardPendingChanges),
    );
  let outcome: ActivateResult;
  try {
    outcome = await activate(false);
  } catch (error) {
    // 서버가 「계속하려면 확인해 주세요」라고 말했는데 확인할 자리가 없으면 그 문장이 곧 막다른
    // 길이다. **여기 하나만 뚫는다** — 다른 거절(게시 진행 중·AI 작업 중)에는 동의로 넘어가는
    // 길이 없고, 넓히면 뚫을 수 없는 거절에도 동의 창을 띄우게 된다.
    // 발행 전 편집은 **동의로 못 뚫는다** — 안내하고 멈춘다. 그냥 던지면 빨간 오류창에 서버
    // 문장만 뜨고 **어디로 가야 하는지가 없다**(= 막다른 길).
    if (isDraftInProgress(error)) {
      await tellDraftBlocked(tenant, (error as Error).message);
      return;
    }
    if (!needsDiscardConsent(error)) throw error;
    if (
      !(await askDiscardConsent(
        tenant,
        (error as Error).message,
        error instanceof DevtoolsError ? error.serverCode ?? null : null,
      ))
    )
      return;
    // ⚠ **재시도도 안내 분기를 지난다.** 백엔드 가드는 **게시 대기 AI 변경(4층)을 편집(5층)보다
    //    먼저** 던진다 — 둘이 겹친 테넌트에서는 첫 호출이 4층에 걸려 편집이 가려지고, 동의한 뒤
    //    재시도가 `DRAFT_IN_PROGRESS` 로 거절된다. 그것을 맨몸으로 두면 **빨간창에 서버 문장만
    //    뜨고 어디로 가야 하는지가 없다** — 이 판이 지우겠다고 선언한 바로 그 형상이다.
    //    형제 발행 문은 이미 그렇게 받는다(`publishCommand` 의 catch) — 비대칭을 없앤다.
    try {
      outcome = await activate(true);
    } catch (retried) {
      if (!isDraftInProgress(retried)) throw retried;
      await tellDraftBlocked(tenant, (retried as Error).message);
      return;
    }
  }
  // ⚠ **판이 안 움직인 경우를 「바꿨습니다」로 말하지 않는다.** 이미 켜진 판을 고르면 서버는
  //    전환이 아니라 「지금으로 되돌리기」를 하고 판은 그대로 둔다 — 그때 「바꿨습니다」는 거짓이다.
  //    판정은 core 가 한다(`switchOutcome`) — 결여는 `true` 방향이라 구서버에서는 종전과 같다.
  //
  // ⚠ **로그도 같은 분기를 탄다.** 알림과 로그가 갈리면 로그가 거짓 증언이 된다.
  // 한 번만 짓고 두 자리가 나눠 쓴다 — 두 번 부르면 나중에 한쪽만 고쳐진다.
  // 표기를 안 붙인다: 소독 검사가 이 식별자를 **선언표로 역추적**해 `say` 유래임을 본다.
  // 표기로 덮으면 그 변수를 나중에 오염시켜도 안 걸린다(검사기가 눈을 감는다).
  const said = say.switchOutcome(tenant, target.revisionNo, outcome);
  log(said);
  void vscode.window.showInformationMessage(said);
}

/**
 * D1「배포 전 검사」 — **조언이지 차단이 아니다.** 결과가 무엇이든 발행을 막지 않는다. 서버가 받아 줄 것을
 * 확장이 먼저 막으면 소스 재업로드 경로를 우리 손으로 좁히는 것이 된다(memo138 §3.3).
 */
async function precheckCommand(): Promise<void> {
  const dir = requireWorkspace();
  const config = handshake ?? (await ensureHandshake());
  const findings = await precheck({
    projectDir: dir,
    minClientVersion: config.minClientVersion,
  });

  output.show();
  log("── 배포 전 검사(조언) ──");
  for (const finding of findings) {
    log(`${finding.level === "warn" ? "⚠" : "·"} ${finding.message}`);
    if (finding.hint) log(`   → ${finding.hint}`);
  }
  const warnings = findings.filter((f) => f.level === "warn").length;
  log(
    warnings === 0
      ? "· 걸리는 것이 없습니다."
      : `⚠ 짚을 것 ${warnings}건 — 그래도 발행은 할 수 있습니다.`,
  );
}

/**
 * B3 — 이미 가진 폴더를 이 테넌트에 붙인다. 지금은 테넌트 코드를 설정에 적는 것이 전부다.
 *
 * 「이 폴더의 사이트로 돌아가기」 — 어긋난 상태의 **탈출구**.
 *
 * 「사이트에 연결」과 다르다: **소속을 바꾸지 않고 링크만 소속에 맞춘다.** 그래서 동의 모달이 없다 —
 * 이 폴더가 원래부터 속해 있던 사이트로 창을 되돌릴 뿐이다.
 *
 * ⚠ 표식이 그 사이 사라졌으면 **아무것도 쓰지 않는다.** 링크만 남은 폴더에서 이 명령이 그 링크를
 *   자기 자신으로 다시 적어 봐야 하는 일이 없고, 없는 소속을 지어내면 그것이 오염이다.
 */
async function useFolderSite(): Promise<void> {
  const dir = requireWorkspace();
  const mark = readSourceMarkAt(dir);
  if (mark === null) {
    void vscode.window.showInformationMessage(
      ours("이 폴더에는 사이트 표식이 없습니다 — 「사이트에 연결」로 사이트를 정해 주세요."),
    );
    return;
  }
  await vscode.workspace
    .getConfiguration("zalkera")
    .update("tenant", mark.tenant, vscode.ConfigurationTarget.Workspace);
  rememberFolder(mark.tenant, dir);
  log(`작업 사이트를 이 폴더의 사이트(${mark.tenant})로 되돌렸습니다.`);
  await refreshSidebar();
  void vscode.window.showInformationMessage(say.backToFolderSite(mark.tenant));
}

/**
 * 소속 표식을 `linked` 로 남긴다. **링크 쓰기와 짝으로만 부른다** — 둘이 갈리면 「어긋남은
 * 사고다」가 성립하지 않는다(어느 쪽을 믿을지 알 수 없는 폴더가 생긴다).
 *
 * ⚠ **한 자리에 모아 둔다.** 두 경로(「사이트에 연결」·「로컬본 폴더 직접 고르기」)가 각자 쓰면
 *   언젠가 한쪽만 고쳐지고, 그 한쪽이 표식 없이 링크만 남기는 자리가 된다. 배선 검사가 이 자리
 *   하나를 센다.
 *
 * 실패는 로그만 남긴다 — 연결 자체를 실패로 만들지 않는다(받기·발행과 같은 규율).
 */
async function markFolderLinked(dir: string, tenant: string): Promise<void> {
  const marked = await writeBindingMarkTo(dir, {
    origin: "linked",
    tenant,
    linkedAt: new Date().toISOString(),
  });
  if (!marked.ok) {
    log(`소속 표식을 남기지 못했습니다(${marked.reason}) — 연결 자체는 끝났습니다.`);
  }
}

async function linkFolder(): Promise<void> {
  // 폴더가 없으면 연결할 대상이 없다 — 종전에는 전역에 적어 놓고 "이 작업 공간을" 이라고 말했다.
  if (workspaceDir() === undefined) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "열린 폴더가 없습니다.",
      "소스 폴더를 먼저 여신 뒤 다시 눌러 주세요.",
    );
  }
  const api = await ensureApi();
  const tenants = await api.listMyTenants();
  const choice = await vscode.window.showQuickPick(
    tenants.map((t) => ({ label: t.name, description: t.code })),
    { title: "이 폴더를 어느 사이트로 연결할까요?" },
  );
  if (!choice?.description) return;
  const dir = requireWorkspace();
  const binding = currentFolderBinding();
  // ⚠ **소속을 바꾸는 것은 이 자리뿐이다.** 그래서 조용히 하지 않는다 — 이 폴더의 소스가 다른
  //    사이트로 올라가게 되는 변경이다.
  if (needsRelinkConsent(binding, choice.description)) {
    const go = await vscode.window.showWarningMessage(
      say.relinkConfirm(binding ?? "", choice.description),
      { modal: true },
      "다시 연결",
    );
    if (go !== "다시 연결") return;
  }
  // ⚠ **`saveTenant` 를 지나지 않는다.** 그 판정은 「사이트 선택이 남의 폴더를 덮지 못하게」 하는
  //    것이고, 이 자리는 소속을 **정하는** 쓰기라 그 판정에 걸리면 재연결 자체가 불가능해진다.
  await vscode.workspace
    .getConfiguration("zalkera")
    .update("tenant", choice.description, vscode.ConfigurationTarget.Workspace);
  // 링크와 표식을 **같이** 쓴다 — 둘이 갈리면 「어긋남은 사고다」가 성립하지 않는다.
  //
  // ⚠ **소속이 안 바뀌면 표식은 그대로 둔다.** 같은 사이트를 다시 골랐을 뿐인데 덮으면,
  //    받기 표식의 판 번호·sha256 이 사라져 「이미 받아 두셨습니다」 힌트가 죽는다.
  if (binding !== choice.description) {
    await markFolderLinked(dir, choice.description);
  }
  rememberFolder(choice.description, dir);
  log(
    `이 폴더를 ${plainNotice(choice.label, 64)}(${plainNotice(choice.description, 64)}) 에 연결했습니다.`,
  );
  // ⚠ **적었으면 화면도 바꾼다.** 종전에는 설정만 바꾸고 사이드바가 옛 사이트를 계속 보여 줬다 —
  //    배송 문서가 "고른 사이트는 그룹 이름 옆에 늘 보입니다"라고 그 표시를 근거로 삼는다.
  await refreshSidebar();
  void vscode.window.showInformationMessage(
    `이 폴더를 ${plainNotice(choice.label, 64)} 사이트에 연결했습니다.`,
  );
}

// ── 미리보기 ──────────────────────────────────────────────────────────────

async function startPreviewCommand(pinned?: CapturedTenant): Promise<void> {
  if (session) {
    await vscode.env.openExternal(vscode.Uri.parse(session.server.url));
    return;
  }
  // 두 번 누르면 키가 2회 발급돼 **두 번째가 첫 번째를 폐기**하고, dev 서버 2개가 뜨고, 첫 서버는 UI 에서
  // 끌 수 없는 고아가 된다(심의 경고). 첫 실행이 수 분짜리 설치라 실제로 자주 밟힌다.
  if (previewGuard.busy) {
    void vscode.window.showInformationMessage(
      "미리보기를 준비하는 중입니다. 잠시만 기다려 주세요.",
    );
    return;
  }
  // 이 함수가 미리보기 시작의 **유일한 문**이다 — 명령 셋(시작·다시 시작·사이드바 항목)이 전부 여기로
  // 온다. 가드를 등록부에 두면 그중 하나만 덮는다.
  await previewGuard.run(() => startPreviewGuarded(pinned));
}

/**
 * 가드 **안에서만** 부른다. 던져도 core 가드가 `finally` 로 풀어 주므로 여기서 풀지 않는다 —
 * 푸는 자리가 둘이면 반드시 어긋난다.
 */
async function startPreviewGuarded(pinned?: CapturedTenant): Promise<void> {
  try {
    await startPreviewInner(pinned);
  } catch (error) {
    // 시작이 실패했으면 **발급받은 키를 여기서 되돌린다.** 로그아웃까지 미루면 그때까지 서버에
    // 살아 있고, 사용자는 실패했다고 들었으므로 로그아웃할 이유도 못 느낀다.
    if (issuedKey !== null && !session) {
      // **비우는 것이 먼저다.** `await` 뒤에 비우면, 그 사이 시작된 두 번째 시도가 심어 둔 새 키를
      // 이 줄이 지워 버린다(심의 경고). 지역 변수로 옮겨 놓고 폐기한다.
      const doomed = issuedKey;
      setIssuedKey(null);
      await revokeKeyQuietly(doomed.keyId, doomed.tenant);
    }
    throw error;
  }
}

async function startPreviewInner(pinned?: CapturedTenant): Promise<void> {
  const dir = requireWorkspace();
  // ⚠ **캡처한다**(클로징 심의 W1). 종전에는 API 만 캡처 테넌트에 묶이고 dev 서버에 넘기는 값은
  // `tenantCode()` 라이브였다. 그 사이에 await 가 여럿(핸드셰이크·progress 준비) 있어서, 그 틈에
  // 사이트를 바꾸면 **키는 A 로 발급되고 서버 env 는 B** 가 된다.
  const { api, tenant } = await ensureApiFor(pinned);
  const config = await ensureHandshake();
  const runtime = embeddedNodeRuntime(extensionPath);
  // ⚠ **조용히 떨어지지 않는다.** 어느 npm 이 돌았는지 모르는 채 결과만 남으면, 실사용 신고가
  //   왔을 때 물어볼 것이 없다. 고른 이유까지 **정상 흐름에서** 남긴다.
  const npm = resolveNpm(extensionPath, npmPreference(), npmBlindSpots(dir));
  log(`npm: ${describeNpm(npm)} — ${npm.why}`);
  const npmArgv = npmArgvOf(npm, process.execPath);
  if (!npmArgv) {
    // ⚠ **여기서 멈춘다.** `null` 은 "PATH 의 npm 으로 해 보라"가 아니다 — 그 경로는 개발자 기계에서만
    //   서고, 비개발자 기계에서는 `spawn` 이 ENOENT 로 죽어 "인터넷을 확인하세요"라는 틀린 안내가 된다.
    throw new DevtoolsError(
      "DEPENDENCIES_FAILED",
      `의존성을 설치할 npm 이 없습니다 — ${npm.kind === "unavailable" ? npm.why : ""}`,
      npm.kind === "unavailable" ? npm.hint : "잘커라에 문의해 주세요.",
    );
  }

  setStatus("$(sync~spin) 미리보기 준비 중");
  // ⚠ **취소 단추를 준다.** 첫 실행은 수 분짜리 설치이고, 사내망 프록시에 물리면 자식 프로세스가
  //   **끝나지 않는다** — 그러면 이 알림은 영원히 돈다. 이 파일이 이미 적어 둔 "사용자가 반드시 두 번
  //   누른다"는 실측에 재진입 가드는 만들었으면서 **멈출 방법은 안 만들었다**(심의 지적).
  //   `signOut` 도 준비 중에는 거절하므로, 취소가 없으면 남는 탈출구는 편집기 강제 종료뿐이다.
  //   형제 `signIn`(위)이 쓰는 패턴을 그대로 옮긴다.
  const started = await withStartGuard(() =>
    vscode.window.withProgress<PreviewSession>(
      {
        location: vscode.ProgressLocation.Notification,
        title: "미리보기를 준비하는 중",
        cancellable: true,
      },
      (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() =>
          controller.abort(),
        );
        return startPreview({
          signal: controller.signal,
          projectDir: dir,
          api,
          apiBase: apiBase(),
          tenantCode: tenant,
          nodePath: runtime.nodePath,
          extraEnv: runtime.env,
          // 고른 npm 의 **경로**를 넘긴다. 코어에 기본값이 없으므로 이 값이 곧 실행될 것이다.
          npmCommand: npmArgv,
          npmEnv: runtime.env,
          label: `${vscode.env.appName} · ${process.platform}`,
          // 발급 즉시 붙잡는다 — 뒤가 실패해도 로그아웃·초기화가 이 키를 지울 수 있어야 한다.
          onKeyIssued: (keyId) => {
            setIssuedKey({ keyId, tenant });
          },
          onProgress: log,
          onLog: log,
        }).finally(() => subscription.dispose());
      },
    ),
  );

  session = {
    server: started.server,
    projectDir: dir,
    keyId: started.keyId,
    tenant,
  };
  setIssuedKey({ keyId: started.keyId, tenant });
  sidebar.update({
    previewUrl: started.server.url,
    keyExpiresAt: started.expiresAt,
  });
  started.server.onExit((code) => {
    session = null;
    clearRenewal();
    // 만료 표시도 함께 걷는다 — 미리보기가 없는데 "자격증명 만료: …"가 남으면 낡은 화면이다.
    sidebar.update({ previewUrl: null, keyExpiresAt: null });
    showIdleStatus();
    // **상태바를 되돌린다.** 종전에는 텍스트만 바꾸고 command 를 stop 에 둬서, 크래시 뒤 상태바를
    // 누르면 session 이 없어 아무 일도 안 하는 죽은 버튼이 됐다(심의 경고).
    if (code !== 0 && code !== null)
      log(`미리보기가 종료되었습니다(코드 ${code}).`);
  });

  setStatus(`$(browser) 미리보기 ${new URL(started.server.url).port}`);
  status.command = "zalkera.preview.stop";

  if (started.revokedPrevious > 0) {
    // 말 없이 끊기면 저쪽 사용자는 그것을 고장으로 읽는다. 저쪽에는 우리가 말할 수 없으므로
    // `dev.ts` 의 `translateLog` 가 그 자리에서 안내한다 — 이 알림은 **이긴 쪽** 몫이다.
    //
    // ⚠ 「다른 기계」라고 단정하지 않는다. 폐기 사유는 셋인데 서버는 셋을 구분해 주지 않는다:
    //   다른 기계 · 같은 기계의 다른 창 · 확장이 비정상 종료돼 서버에 남아 있던 키.
    void vscode.window.showWarningMessage(
      `다른 곳에서 켜 둔 미리보기 ${count(started.revokedPrevious)}개가 해제되었습니다 — 미리보기 자격증명은 한 번에 하나입니다.`,
    );
  }
  if (started.expiresAt) {
    log(
      `미리보기 자격증명 만료: ${new Date(started.expiresAt).toLocaleString("ko-KR")}`,
    );
    scheduleRenewal(started.expiresAt, config.previewKeyTtlSeconds);
  }

  // **웹뷰가 아니라 실제 브라우저로 연다**(§3.5) — 웹뷰는 쿠키·CSP 가 실제 탭과 달라
  // "로컬에선 됐는데 배포하니 다르다"를 만드는 정확한 자리다.
  //
  // ⚠ **여기서 실패해도 미리보기 시작은 성공이다.** 이 줄은 **마지막 await** 이고, 그 앞에서 키
  //    발급·`session` 설정·사이드바·갱신 예약이 전부 끝나 있다. 그런데 던지면 위쪽 호출부까지
  //    올라가 「미리보기를 시작하지 못했습니다」 계열 문면이 뜬다 — 갱신 경로에서는 「갱신하지 못해
  //    미리보기가 멈췄습니다」가 됐다(마감 3회전 차단). **둘 다 거짓이다**: 미리보기는 돌고 있고
  //    브라우저만 안 열렸다. 원격 호스트·오프너 부재에서 실제로 거부된다.
  //
  //    주소는 말해 준다 — 사용자가 직접 열 수 있어야 한다.
  const opened = await vscode.env
    .openExternal(vscode.Uri.parse(started.server.url))
    .then(
      (ok) => ok,
      () => false,
    );
  if (!opened) {
    log(
      `브라우저를 열지 못했습니다 — 주소를 직접 여세요: ${started.server.url}`,
    );
    void vscode.window.showInformationMessage(
      `미리보기가 시작됐습니다. 브라우저를 자동으로 열지 못했으니 주소를 직접 열어 주세요 — ${plainNotice(started.server.url)}`,
    );
  }
}

/**
 * C6「키 만료 자동 갱신」 — 만료 5분 전에 미리보기를 스스로 다시 세운다(재발급 → env 갱신 → dev 재기동).
 *
 * **왜 자동인가**: 만료는 12시간마다 반드시 온다. 그때 사용자가 보는 것은 "갑자기 데이터가 안 나온다"이고,
 * 원인이 자격증명이라는 것을 알 방법이 없다. 조용한 실패를 예약해 두는 셈이라 자동 갱신이 기본이어야 한다.
 *
 * 재기동은 알린다 — 말없이 서버가 재시작되면 그것도 고장으로 읽힌다.
 */
function scheduleRenewal(expiresAt: string, ttlSeconds: number): void {
  clearRenewal();
  // ⚠ 초판은 lead 가 5분 하드코딩이고 서버가 준 TTL(`previewKeyTtlSeconds`)을 **받아만 놓고 안 썼다**.
  // TTL 을 5분 이하로 줄이면 `Math.max(delay, 1_000)` 때문에 **매초 재기동 루프**가 된다 — 매초 키 재발급
  // (직전 키 폐기)에 브라우저 탭까지 다시 열린다. lead 를 TTL 에서 유도하고 **하한을 건다**(심의 경고).
  const leadMs = Math.min(
    5 * 60_000,
    Math.max(30_000, (ttlSeconds * 1000) / 10),
  );
  const delay = new Date(expiresAt).getTime() - Date.now() - leadMs;
  if (!Number.isFinite(delay)) return;
  if (delay < MIN_RENEW_DELAY_MS) {
    // 시계 오차나 아주 짧은 TTL 이면 즉시 재기동으로 달려들지 않는다 — 사람에게 말하고 멈춘다.
    log(
      "미리보기 자격증명 만료가 임박했습니다. 필요하면 미리보기를 다시 시작해 주세요.",
    );
    return;
  }

  renewTimer = setTimeout(() => {
    void (async () => {
      if (!session) return;
      // ⚠ **그때 그 사이트로 다시 세운다.** `zalkera.preview.restart` 는 사람이 누르는 자리라
      //    **지금 고른** 사이트를 쓰는 것이 맞지만, 이 갱신은 사람이 아무것도 안 했는데 도는
      //    타이머다. 여기서 라이브 선택을 다시 읽으면, 사이드바에서 사이트를 바꿔 둔 사이에
      //    미리보기가 **말없이 다른 사이트의 키·env 로** 다시 선다(심의 지적).
      const pinned = session.tenant;
      // ⚠ **이 자리는 `register()` 의 게이트 밖이다** — 사람이 누른 것이 아니라 타이머가 돈다.
      //    그 사이에 이 폴더가 다른 사이트로 재연결됐으면, 다시 세우는 것은 **y 폴더에 x
      //    자격증명을 쓰는 일**이 된다. 게이트가 막는 바로 그 형상이라 여기서도 막는다.
      const boundTo = currentFolderBinding();
      if (boundTo !== null && boundTo !== (pinned as string)) {
        log(`이 폴더가 ${boundTo} 사이트로 바뀌어 미리보기 자격증명을 갱신하지 않습니다.`);
        await stopPreview();
        void vscode.window.showInformationMessage(
          say.renewalStoppedAfterRelink(boundTo),
        );
        return;
      }
      const drifted = tenantCode() !== (pinned as string);
      log(`미리보기 자격증명이 곧 만료되어 다시 세웁니다… (사이트 ${pinned})`);
      void vscode.window.showInformationMessage(
        drifted
          ? `미리보기 자격증명을 갱신합니다 — 미리보기는 시작할 때의 사이트(${plainNotice(pinned, 64)})로 다시 섭니다.`
          : "미리보기 자격증명을 갱신하려고 미리보기를 다시 시작합니다.",
      );
      try {
        await stopPreview();
        await startPreviewCommand(pinned);
      } catch (error) {
        // ⚠ **여기는 `register()` 의 오류 깔때기 밖이다.** 종전에는
        //    `executeCommand("zalkera.preview.restart")` 라 실패가 그 깔때기를 지나
        //    빨간창 + 출력채널로 나왔다. 핀 고정을 위해 직접 호출로 바꾸면서 그 길이
        //    끊겼고, 미리보기는 이미 `stopPreview()` 로 꺼진 뒤라 **사용자는 몇 시간 뒤
        //    미리보기가 말없이 사라진 것만 본다**(마감 심의 차단). 12시간 뒤 오프라인이면
        //    실제로 밟는다. 같은 자리의 KDoc 이 「재기동은 알린다 — 말없이 재시작되면
        //    그것도 고장으로 읽힌다」고 적어 둔 그 규율이다.
        // 판정은 core 가 한다(`errorNotice.ts`) — 여기 사본을 두면 이 자리만 낡는다.
        // 스스로 취소를 누른 사람에게 「갱신하지 못해 멈췄습니다」 빨간창을 띄우면 안 된다.
        const notice = decideErrorNotice(error);
        log(`미리보기 자격증명 갱신 ${notice.logPrefix}: ${notice.raw}`);
        if (notice.kind !== "cancelled") {
          void vscode.window.showErrorMessage(
            `미리보기 자격증명을 갱신하지 못해 미리보기가 멈췄습니다 — ${notice.message}`,
          );
        }
      }
    })();
  }, delay);
  renewTimer.unref?.();
}

/**
 * 실패하면 상태바를 되돌린다.
 *
 * ⚠ **여기서 재진입 가드를 풀지 않는다.** 이 catch 가 도는 동안 바깥에서는 키 폐기가 **수 초** 더
 * 이어진다. 그 창에 가드가 풀려 있으면 「미리보기 시작」이 다시 통과해 새 키가 발급되고, 뒤늦게 끝난
 * 첫 번째 정리가 이 창의 `issuedKey` 를 비워 **두 번째 열쇠의 모듈 참조가 사라진다** — 그 창의
 * 「미리보기 중지」가 자기 열쇠를 못 찾는다. 창 밖 목록(`ISSUED_KEY_STATE`)이 받쳐 로그아웃·초기화는
 * 여전히 지우지만, 받침을 쓰라고 가드를 푸는 것은 아니다.
 *
 * 가드 해제는 `createReentrancyGuard` 의 `finally` 한 곳뿐이다. 푸는 자리가 둘이면 반드시 어긋난다.
 */
async function withStartGuard<T>(run: () => Thenable<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    showIdleStatus();
    throw error;
  }
}

const MIN_RENEW_DELAY_MS = 60_000;

function clearRenewal(): void {
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = null;
}

async function stopPreview(): Promise<void> {
  clearRenewal();
  if (!session) return;
  await session.server.stop();
  session = null;
  sidebar.update({ previewUrl: null, keyExpiresAt: null });
  showIdleStatus();
  log("미리보기를 멈췄습니다.");
}

// ── 새 버전 배포 ────────────────────────────────────────────────────────


/**
 * 발행 전 편집에 막혔다 — **묻지 않고 알린다.**
 *
 * 옆의 [askDiscardConsent] 와 짝처럼 보이지만 반환값이 없는 것이 핵심이다. 서버에 이 거절을 넘기는
 * 인자가 없으므로 「계속할까요」를 물을 수 없다 — 물으면 눌러도 같은 409 가 돌아오고, 그것이 정확히
 * 이 자리가 막으려는 막다른 길이다.
 *
 * 모달로 낸다. 처분은 **다른 화면에서** 해야 하는데, 비-모달 알림은 사람이 못 보고 지나칠 수 있어
 * 「왜 안 올라가지」로 되돌아온다.
 */
async function tellDraftBlocked(
  tenant: CapturedTenant,
  serverMessage: string,
): Promise<void> {
  const notice = say.draftBlocked(tenant, serverMessage);
  await vscode.window.showWarningMessage(notice.message, {
    modal: true,
    detail: notice.detail,
  });
}

/**
 * 게시 대기 중인 AI 변경을 **버리는 데 동의**할지 묻는다.
 *
 * 백엔드는 재업로드·버전 전환·프리셋 재개시 **세 문이 같은 가드**를 지난다. 그러니 사람이 보는
 * 문면도 하나여야 한다 — 자리마다 다른 말을 하면 같은 일인 줄 모른다.
 */
async function askDiscardConsent(
  tenant: CapturedTenant,
  serverMessage: string,
  serverCode: string | null,
): Promise<boolean> {
  const ask = say.discardPendingConfirm(tenant, serverMessage, serverCode);
  const answer = await vscode.window.showWarningMessage(
    ask.message,
    { modal: true, detail: ask.detail },
    ask.action,
  );
  return answer === ask.action;
}

/**
 * 「그대로 올리기」 동의 — [askDiscardConsent] 와 **다른 문이다.** 사라지는 것이 다르다(내 편집 vs
 * 남의 변경)라, 같은 동의로 뚫으면 **다른 행위에 대한 동의**를 받는 것이 된다.
 */
async function askBaseMoved(tenant: CapturedTenant, serverMessage: string): Promise<boolean> {
  const ask = say.baseMovedConfirm(tenant, serverMessage);
  const answer = await vscode.window.showWarningMessage(
    ask.message,
    { modal: true, detail: ask.detail },
    ask.action,
  );
  return answer === ask.action;
}

/**
 * 「새 버전 배포」 — **이 명령이 곧 배포다.** 확장은 `confirmArchive` 까지만 부르지만, 백엔드가
 * 그 판을 켠다: STATIC 은 확정 즉시, NEXT_SOURCE 는 빌드가 끝나는 순간이다.
 *
 * 그래서 확인 모달이 **마지막 확인 지점**이고, 여기서 안 바뀐다고 말하면 사람은 그것을 읽지 않고
 * 넘긴 뒤 미검수 소스를 손님에게 보낸다.
 */
async function publishCommand(): Promise<void> {
  const dir = requireWorkspace();
  const { api, tenant } = await ensureApiFor();

  // 문구는 core 가 만든다 — **`tenant` 를 인자로 요구하므로 라이브로 읽을 방법이 없다**(§tenantScope).
  // 오늘 이 자리에서 난 결함이 정확히 "알림이 라이브로 다시 읽는 것"이었다.
  // ⚠ **경로와 소속을 함께 넘긴다.** 경로는 `message` 의 「이 폴더」가 가리키는 것이고(모달이
  //    뜨면 사이드바는 안 보인다), 소속은 **모양을 가르는 재료**다 — 소속 없는 폴더의 발행은
  //    다른 모달을 봐야 한다(`say.publishConfirm` 의 KDoc).
  // 이 올리기가 딛는다고 **선언할 판**. 표식이 판을 주장할 때만 값이 있다(`declaredBaseRevisionNo`) —
  // 「사이트에 연결」로 이은 폴더와 무표식 폴더는 선언할 값이 없고, **없는 값을 지어내면 근거 없이
  // 남을 막는다.**
  const baseRevisionNo = declaredBaseRevisionNo(readSourceMarkAt(dir), tenant);
  // ⚠ **무보호를 고지한다** — 문면은 core 가 만든다(변수를 모달에 이어 붙이면 소독 검사 밖으로 떨어진다).
  const ask = say.publishConfirm(tenant, dir, currentFolderBinding(), baseRevisionNo != null);
  const confirm = await vscode.window.showWarningMessage(
    ask.message,
    { modal: true, detail: ask.detail },
    ask.action,
  );
  if (confirm !== ask.action) return;

  // ⚠ **`onConsent` 로는 이 갈래를 못 받는다.** 동의 콜백은 「동의로 넘어갈 수 있는 거절」에만
  //    불린다(core `needsDiscardConsent`). 발행 전 편집은 동의 인자가 없는 거절형이라 그대로
  //    던져져 나오고, 여기서 안 받으면 빨간 오류창에 서버 문장만 남는다 — 어디로 가야 하는지가
  //    없는 것이 곧 막다른 길이다(memo183 §7).
  let result: PublishResult;
  try {
    result = await vscode.window.withProgress<PublishResult>(
      // ⚠ **취소를 낼 수 있게 한다.** 종전엔 버튼이 없어 시작하면 끝날 때까지 못 멈췄다.
      //    ⚠ 그런데 취소가 「무엇을 되돌리는가」는 구간마다 다르다 — 그 경계는 `publish()` 의
      //      `signal` KDoc 이 든다(요지: `confirm` 에는 안 붙는다).
      { location: vscode.ProgressLocation.Notification, title: "올리는 중", cancellable: true },
      (progress, token) => {
        const stop = new AbortController();
        // ⚠ **누른 즉시 문면을 바꾼다.** `confirm` 상한이 30초라, 누른 취소가 그동안 무반응이면
        //    「안 먹는다」로 읽혀 사람이 창을 죽인다. 이 문장은 아는 것만 말한다.
        token.onCancellationRequested(() => {
          stop.abort();
          progress.report({ message: "멈추는 중 — 서버 확인이 이미 나갔으면 결과를 기다립니다" });
        });
        return publish({
          projectDir: dir,
          api,
          tenant,
          onProgress: log,
          // 서버가 「계속하려면 확인해 주세요」라고 말한 자리 — 확인할 곳을 준다. 전환 쪽과
          // **같은 문면**을 쓴다: 두 문이 같은 가드를 지나므로 사람이 보는 말도 같아야 한다.
          onConsent: (serverMessage, serverCode) =>
            askDiscardConsent(tenant, serverMessage, serverCode),
          baseRevisionNo,
          // 이 문이 없으면 화면은 **막다른 길**이 된다 — 표식은 발행 성공에서만 갱신되므로 다음
          // 올리기도 같은 번호를 선언해 같은 409 를 무한히 맞는다. 사람이 최신 변경을 손으로 합쳐
          // 넣어도 표식은 옛 번호라 빠져나갈 수 없다.
          onBaseMoved: (serverMessage) => askBaseMoved(tenant, serverMessage),
          signal: stop.signal,
        });
      },
    );
  } catch (error) {
    if (isDraftInProgress(error)) {
      await tellDraftBlocked(tenant, (error as Error).message);
      return;
    }
    // 사람이 스스로 그만둔 일은 **실패가 아니다** — 빨간창을 내지 않는다. 그리고 판이 안
    // 만들어졌다는 것만 말한다(바이트·흔적은 우리가 확실히 아는 사실이 아니다 — `say` KDoc).
    if (isCancelled(error)) {
      void vscode.window.showInformationMessage(say.publishCancelled(tenant));
      return;
    }
    throw error;
  }
  // ⚠ **유형을 함께 남긴다.** 이 값이 뒤 흐름을 통째로 가른다 — `STATIC` 은 확정 즉시 게시라
  //    빌드 대기가 아예 없고(진행 표시도 없다), `NEXT_SOURCE` 는 서버가 빌드를 마쳐야 게시된다.
  //    같은 소스를 다른 기계에서 올렸는데 화면이 다르면 첫 질문이 "무엇으로 판별됐나"인데,
  //    종전에는 그 답이 어디에도 안 남아 되물을 수밖에 없었다.
  log(
    `버전 ${countJosa(result.revisionNo, "으로/로")} 올렸습니다 — 파일 ${count(result.fileCount)}개 · ${Math.round(result.byteSize / 1024)}KB · 유형 ${result.siteType} · 상태 ${result.status}`,
  );
  // ⚠ **취소가 늦었어도 여기서 되돌아가지 않는다.** 판은 만들어졌으므로 아래 부수효과(표식 갱신·
  //    폴더 기억·서버 고지)를 **그대로 해야 한다** — 건너뛰면 화면이 아니라 **디스크에 거짓**이
  //    남는다: 표식이 옛 판을 든 채라 다음 발행이 낡은 기반을 선언하고, **자기가 방금 만든 판**에
  //    대해 「그 사이 다른 변경이 올라왔습니다」를 맞는다(제조된 거짓말).
  //    갈리는 것은 **마지막 문면과 기다리기**뿐이다(아래 `cancelledLate`).
  // 서버가 보낸 한계·상태 안내는 **그대로 보여 준다**(memo66 §4 거짓 성공 차단).
  //
  // ⚠ **출력 패널에만 적는 것은 차단이 아니다.** 이 문장이 「정적 사이트로 게시됐습니다 — 상품·
  //    재고·예약 등 실시간 데이터는 표시되지 않습니다」를 말하는 자리인데, 확장은 그 패널을
  //    자동으로 열지 않는다. 사람은 사이트가 왜 다른지 모른 채로 남고, 같은 소스를 다른 기계에서
  //    올렸을 때 결과가 갈리는 이유도 여기 적혀 있다가 그대로 묻힌다.
  //
  //    서버 문장이라 표시 자리에서 소독한다. 유형별로 낼지 말지 고르지 않는다 — 무엇이 고지할
  //    값인지는 서버가 정하고, 확장이 문장을 읽어 판단하면 서버가 말을 바꾸는 날 조용히 삼킨다.
  if (result.capabilityNote) {
    log(result.capabilityNote);
    void vscode.window.showInformationMessage(
      plainNotice(result.capabilityNote, 300),
    );
  }

  // ⚠ **여기서 이 폴더의 소속이 사실이 된다.** 표식 없이 발행한 폴더(프리셋 시작·구판 받기·타
  //    입구)는 그때까지 어느 사이트의 것도 아니었는데, 사이트 이름을 박은 확인 모달을 지난 이
  //    발행이 그것을 정한다. 다음부터는 게이트가 이 폴더를 지킨다.
  //
  //    받기와 **동의의 성격이 다르다**: 받기의 표식은 사용자가 대상으로 고른 폴더에 생기지만,
  //    이 표식은 파일 생성을 고른 적 없는 폴더에 부수효과로 생긴다. 비밀이 아니고 zip 제외·
  //    `.gitignore` 가 걸려 있어 수용하지만, 그 차이는 여기 적어 둔다.
  const marked = await writeBindingMarkTo(dir, {
    origin: "published",
    tenant: String(tenant),
    revisionNo: result.revisionNo,
    publishedAt: new Date().toISOString(),
  });
  if (marked.ok) {
    log(`이 폴더를 ${tenant} 사이트의 소스로 표시했습니다.`);
  } else {
    log(`소속 표식을 남기지 못했습니다(${marked.reason}) — 발행 자체는 끝났습니다.`);
  }
  rememberFolder(String(tenant), dir);

  if (result.cancelledLate) {
    // ⚠ **취소가 늦었으면 여기서 갈린다.** 판은 만들어졌으니 위 부수효과는 다 했고, 남은 것은
    //    **기다리기**뿐이다 — 그만두겠다고 한 사람을 빌드 대기에 붙들지 않는다. 다만 「취소했습니다」로
    //    접지 않는다: 판은 있고 준비되면 게시된다(빌드 대기 취소와 같은 의미론).
    //
    //    ⚠ **이 블록은 표식 갱신·폴더 기억 「뒤」여야 한다.** 위로 올리면 화면이 아니라 **디스크에
    //       거짓**이 남는다 — 표식이 옛 판을 든 채라 다음 발행이 낡은 기반을 선언하고, 자기가 방금
    //       만든 판에 대해 409 를 맞는다. **주석은 순서를 못 지킨다**(블록만 옮기고 이 주석을 두고
    //       가면 그만이다). 그래서 `check-wiring` 이 **줄머리부터** 연속 조각으로 고정한다 — 위
    //       두 문장을 조건부로 감싸는 길까지 같이 막는다.
    void vscode.window.showInformationMessage(
      say.publishCancelledLate(tenant, result.revisionNo, result.status === "READY"),
    );
    return;
  }

  // `STATIC` 은 올리는 즉시 READY·활성이지만 `NEXT_SOURCE` 는 서버가 빌드를 마쳐야 게시된다.
  // 기다리는 이유가 그것이다 — 여기서 이야기를 끊으면 언제 손님에게 나가는지 알 수 없다.
  const ready =
    result.status === "READY"
      ? true
      : await awaitBuild(api, result.revisionNo, tenant);
  if (!ready) return;

  await announcePublished(api, result.revisionNo, tenant);
}

/**
 * ⚠ **관측값은 60초에 한 번만 바뀐다** — 상행이 오케스트레이터 동기화 틱에 붙어 있기 때문이다.
 *   그보다 촘촘히 물으면 **같은 사실을 되풀이해 받는다.** 실측(판 100개 기준): 5초×36 은 요청 36건·
 *   백엔드 질의 108회·1,097KB 인데, 15초×12 는 12건·36회·366KB 로 **같은 180초를 덮는다.**
 *   대가는 검출 지연 평균 +5초이고, 사람은 이미 2분을 기다리는 흐름이다.
 */
const REFLECT_POLL_MS = 15_000;
/**
 * 상한 **180초 — 늘리지 마라.** 세션이 살아 있는 사이트의 최악 반영 지연이 `2 × 스냅샷 주기 + refresh`
 * ≈ 125초라 한 주기의 여유를 둔 값이다.
 *
 * ⚠ **세션이 없는 사이트는 시간이 아니라 사건(방문자 도착)에 매여 있다** — 방문자가 오기 전엔 영영
 *   안 뜨므로 상한을 10분으로 늘려도 결과는 똑같은 침묵이고 요청만 는다. 못 보는 것은 못 본 채로
 *   끝내는 것이 옳다(「아직 반영 안 됐습니다」는 우리가 아는 사실이 아니다).
 *
 * ⚠ 이 값은 박스의 `SYNC_INTERVAL_MS`(기본 60초)와 **결합돼 있다.** 그쪽을 90초로 올리면 최악이
 *   180초가 되어 반영되는 바로 그 순간에 조용히 포기한다. 두 레포에 걸쳐 있어 검사기가 없다.
 */
const REFLECT_POLL_MAX = 12;
/**
 * `unknown` 을 참는 폴 수. 스냅샷 주기(기본 60초) + 여유를 덮는다 — 그동안은 「관측이 없는 사이트」와
 * 「관측이 이제 막 시작될 사이트」를 구별할 수 없으므로, **못 가르는 것을 안다고 말하지 않는다.**
 */
const UNKNOWN_GRACE_POLLS = 5;
/**
 * 반영 확인이 읽을 판 수. 방금 올린 판과 활성 판은 **꼬리 쪽**이라 이만큼이면 닿는다 —
 * 그 사이에 20판이 더 올라가 밀려났다면 이미 `superseded` 라 감시가 끝날 자리다.
 */
const REFLECT_PAGE = 20;

/**
 * 게시한 판이 방문자에게 닿으면 **한 번만** 알린다. 실패·상한·관측 없음은 전부 **침묵**이다 —
 * 게시 자체는 이미 알렸고, 여기서 더 말할 사실이 없다.
 *
 * 반영 확인 폴링 — **끝나는 것이 급소다.**
 *
 * 게시는 지시일 뿐이라 실제 반영은 서빙박스 주기에 달려 있다(그 값을 우리는 소유하지 않는다).
 * 그래서 숫자를 문장에 박는 대신 **관측이 올 때까지 물어보고**, 오면 그때 알린다.
 *
 * ⚠ **영원히 묻지 않는다.** 관측이 없는 사이트(구 백엔드·박스 미보고·git 레인)는 첫 물음에
 *   `unknown` 이 나와 그 자리에서 끝난다. 그 밖에도 상한을 둔다 — 상한에 닿으면 **아무 말도 안 한다.**
 *   「아직 반영 안 됐습니다」는 우리가 아는 사실이 아니다(그저 못 봤을 뿐이다).
 */
async function watchReflection(api: ZalkeraApi, revisionNo: number, tenant: CapturedTenant): Promise<void> {
  const stop = new AbortController();
  reflectionWatches.add(stop);
  try {
    await pollReflection(api, revisionNo, tenant, stop.signal);
  } finally {
    reflectionWatches.delete(stop);
  }
}

/**
 * 지금 도는 반영 확인들. **확장이 내려갈 때 끊을 손잡이**다 — 폴링은 스스로 안 멈추고, 상한(180초)은
 * 「끝난다」를 보장할 뿐 「지금 끝난다」를 보장하지 않는다.
 */
const reflectionWatches = new Set<AbortController>();

/** 확장 비활성 — 도는 감시를 전부 끊는다. 알림도 안 뜬다(이미 없는 맥락을 말하게 된다). */
function stopReflectionWatches(): void {
  for (const w of reflectionWatches) w.abort();
  reflectionWatches.clear();
}

async function pollReflection(
  api: ZalkeraApi,
  revisionNo: number,
  tenant: CapturedTenant,
  signal: AbortSignal,
): Promise<void> {
  for (let i = 0; i < REFLECT_POLL_MAX; i += 1) {
    await new Promise((r) => setTimeout(r, REFLECT_POLL_MS));
    // ⚠ **잠든 사이에 꺼질 수 있다.** 깨어난 자리에서 먼저 본다 — 안 보면 이미 내려간 확장이 조회를
    //    한 번 더 내보내고, 최악에는 없는 창에 대고 알림을 띄운다.
    if (signal.aborted) return;
    let state: ReflectionState;
    try {
      // ⚠ **전량을 안 받는다.** `reflectionOf` 가 보는 것은 셋뿐이다 — 관측이 도는 사이트인가·활성
      //    판·내 판. 그런데 이 폴링은 관측 없는 사이트에서 유예까지 여러 번 도므로, 전량을 읽으면
      //    판이 쌓인 테넌트에서 그 비용이 폴마다 되풀이된다. 방금 올린 판과 활성 판은 꼬리 쪽이다.
      state = reflectionOf(await api.listRevisions(REFLECT_PAGE), revisionNo);
    } catch (e) {
      // 조회 실패는 반영 실패가 아니다 — 다음 차례에 다시 묻는다. 사람에게는 말하지 않는다.
      log(`반영 확인 조회 실패(계속 시도): ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (state === "reflected") {
      void vscode.window.showInformationMessage(say.reflected(tenant, revisionNo));
      return;
    }
    // ⚠ **첫 게시의 `unknown` 은 「관측이 없는 사이트」가 아니라 「아직 안 시작된 사이트」다.**
    //   관측 행은 사이트가 스냅샷에 처음 등장한 뒤 박스의 다음 틱(≤60초)에야 생긴다 — 제어가 관측
    //   행을 미리 깔지 않는 것이 이 설계의 요지이기 때문이다. 첫 폴 한 번으로 끊으면 **사이트가
    //   처음 세상에 보이는 순간**, 즉 이 알림의 가치가 가장 큰 자리에서 알림이 죽는다.
    //   한 동기화 주기만큼 기다려 보고, 그 뒤에도 없으면 그때가 진짜 「관측이 안 도는 사이트」다.
    if (state === "unknown" && i < UNKNOWN_GRACE_POLLS) continue;
    // 관측이 없거나(unknown) 다른 판으로 갈아탔으면(superseded) 기다리던 사건은 안 온다.
    if (state !== "pending") {
      log(`반영 확인 종료(${state}) — 버전 ${revisionNo}`);
      return;
    }
  }
  log(`반영 확인 상한 도달 — 버전 ${revisionNo}(못 봤을 뿐, 반영 실패가 아니다)`);
}

/**
 * 게시됐다고 **알리고 끝낸다.** 물어볼 것이 없다 — 사이트는 이미 바뀌었다.
 *
 * 확인 없이 나가는 것을 확장이 막을 수는 없다(백엔드가 켠다). 그래서 **가서 볼 길**을 준다 —
 * 나갔다는 사실도, 볼 자리도 숨기지 않는다.
 */
async function announcePublished(
  api: ZalkeraApi,
  revisionNo: number,
  tenant: CapturedTenant,
): Promise<void> {
  const site = await siteUrlOf(api, tenant);
  // 게시 사실도 출력에 남긴다 — 알림은 몇 초 뒤 사라지고, `STATIC` 은 빌드를 안 타서 위
  // 「빌드 완료」 줄조차 없다. 주소를 아는 경우에는 같이 적는다(가서 볼 자리).
  // ⚠ **주소를 줄 끝에 두고 뒤에 문장부호를 붙이지 않는다.** 출력 패널이 URL 을 링크로 잡을 때
  //    붙은 마침표까지 주소로 먹는 자리가 있다.
  log(`버전 ${revisionNo} 게시됐습니다.${site ? ` ${site.url}` : ""}`);
  // ⚠ **단추에 어디로 가는지 적는다.** 주소는 서버가 준 값이고 우리는 그것을 보증하지 못한다 —
  //    「사이트 열기」라고만 쓰면 **우리 이름으로 뜬 단추**가 사람을 아무 데나 데려갈 수 있고,
  //    데스크톱에서 http(s) 는 확인 대화 없이 열린다. 호스트를 보이면 사람이 판단할 수 있다.
  const open = site ? `「${plainNotice(site.host, 64)}」 열기` : null;
  // ⚠ **문구를 지역 변수로 빼지 않는다.** 알림 소독 검사기는 본문이 `say.*` 호출 **그 자리**에
  //    있는지를 보고, 한 번 변수를 거치면 허용 목록 밖으로 떨어진다. 주소가 없으면 단추도 없으므로
  //    호출을 둘로 가르는 대신 **단추 목록을 편다** — 부르는 자리는 하나로 남는다.
  // 반영 확인은 **뒤에서 돈다.** 여기서 기다리면 단추가 뜨기까지 사람이 멈춰 선다 — 게시는 이미 끝났고
  // 사이트를 보러 갈 수 있어야 한다. 실패해도 이 흐름에 영향 0(그쪽은 전부 침묵으로 끝난다).
  void watchReflection(api, revisionNo, tenant);
  const chosen = await vscode.window.showInformationMessage(
    say.published(tenant, revisionNo),
    ...(open ? [open] : []),
  );
  if (!site || chosen !== open) return;

  // 브라우저를 못 여는 자리가 실제로 있다(원격 호스트·오프너 부재). 그때도 **게시는 끝났다** —
  // 실패로 말하지 않고 주소를 준다. 단추를 눌렀는데 아무 일도 안 일어나면 안 되므로 로그만이
  // 아니라 **알림으로도** 말한다(미리보기 시작이 쓰는 규율과 같게).
  const opened = await vscode.env.openExternal(vscode.Uri.parse(site.url)).then(
    (ok) => ok,
    () => false,
  );
  if (opened) return;
  log(`브라우저를 열지 못했습니다 — 주소를 직접 여세요: ${site.url}`);
  void vscode.window.showInformationMessage(
    `브라우저를 자동으로 열지 못했습니다. 주소를 직접 열어 주세요 — ${plainNotice(site.url)}`,
  );
}

/**
 * 열어도 되는 호스트의 모양. **이것이 유일한 관문이다** — 뒤의 `httpUrl` 은 스킴만 보는데 여기서
 * `:` 를 이미 막으므로 새로 막는 것이 없다. 느슨하게 고치면 뒤에 받아 줄 것이 없다.
 *
 * 막는 것: 경로(`/`)·질의(`?`)·조각(`#`)·자격증명(`@`)·포트(`:`)·역슬래시·공백·비-ASCII·
 * 앞뒤 점·앞뒤 하이픈. 길이는 DNS 상한 253 으로 죈다.
 *
 * 막지 **않는** 것: 루프백·사설망·메타데이터 IP, TLD 없는 이름. https GET 한 번이고 사람이
 * 눌러야 열리므로 여기서 더 좁히지 않는다 — 좁히면 사내망에 띄운 정상 사이트를 못 연다.
 */
const SITE_HOST = /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/i;

/**
 * 게시된 사이트의 주소와 호스트. **서버가 준 값만 쓴다**(`/api/me` 의 `tenants[].primaryDomain`) —
 * 베이스 도메인을 확장이 조립하면 그 지식의 사본이 하나 더 생기고, 커스텀 도메인을 쓰는 사이트에서는
 * 그 사본이 **틀린 주소**를 연다.
 *
 * 못 구하면 `null` 이고 그때는 단추를 안 낸다. **없는 주소를 여는 것보다 안 내는 편이 낫다.**
 *
 * ⚠ **전체를 감싸 삼킨다.** 거부만 삼키면 응답의 **모양**이 어긋날 때 그대로 던진다(`tenants` 가
 *   배열이 아니면 `.find` 가 없다). 그 예외는 명령 깔때기까지 올라가 **이미 끝난 게시를 실패로
 *   보고한다** — 이 파일이 고치려는 거짓 형상 그대로다. 다만 **말없이** 삼키지는 않는다.
 */
async function siteUrlOf(
  api: ZalkeraApi,
  tenant: CapturedTenant,
): Promise<{ url: string; host: string } | null> {
  try {
    const tenants = await api.listMyTenants();
    if (!Array.isArray(tenants)) return null;
    // ⚠ **양쪽을 다듬어 견준다.** 백엔드는 `X-Tenant` 헤더를 `trim` 해서 받으므로 설정에 공백이
    //    섞여도 업로드는 성공한다 — 여기서만 안 맞으면 **단추가 조용히 사라진다.**
    // ⚠ 본사 계정은 소속 목록이 비어 있고 사이트 코드를 직접 입력한다. 그 코드는 이 목록에 없어
    //    늘 빗나가고, 그래서 단추가 안 뜬다 — 우리가 주소를 모르는 것이 사실이라 그대로 둔다.
    const wanted = String(tenant).trim();
    const found = tenants.find(
      (t) => typeof t?.code === "string" && t.code.trim() === wanted,
    );
    const host =
      typeof found?.primaryDomain === "string" ? found.primaryDomain.trim() : "";
    if (!host || !SITE_HOST.test(host)) return null;
    const url = httpUrl(`https://${host}`);
    return url ? { url: url.toString(), host } : null;
  } catch (error) {
    log(
      `사이트 주소를 확인하지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * 빌드가 끝날 때까지 지켜본다. **여기서 켜지 않는다** — 켤 필요가 없다. 게시는 빌드 콜백이 한다.
 *
 * 취소는 **기다리기를 그만두는 것**이지 빌드를 멈추는 것이 아니다. 서버는 계속 짓고, 끝나면
 * 게시한다 — 그 사실을 말해 주지 않으면 사용자는 자기가 취소해서 안 나간 줄 안다.
 */
async function awaitBuild(
  api: ZalkeraApi,
  revisionNo: number,
  tenant: CapturedTenant,
): Promise<boolean> {
  // 경과는 **여기서** 잰다. `waitForBuild` 는 판정만 돌려주고 시간을 안 싣는데, 그것을 실으려면
  // 코어 계약이 넓어진다 — 화면에 쓸 숫자 하나 때문에 그럴 일이 아니다.
  const startedAt = Date.now();
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: say.building(tenant, revisionNo),
      cancellable: true,
    },
    (_progress, token) =>
      waitForBuild({
        revisionNo,
        listRevisions: () => api.listRevisions(),
        onProgress: log,
        isCancelled: () => token.isCancellationRequested,
      }),
  );

  switch (outcome.kind) {
    case "ready":
      // ⚠ **성공도 출력에 남긴다.** 실패·타임아웃·취소·추월은 전부 로그를 남기는데 성공만
      //    조용해서, 출력 채널에는 「빌드하는 중… (52초)」가 마지막 줄로 남고 끝났다는 말이
      //    없었다. 알림은 사라지고 출력은 남는다 — 나중에 「그래서 언제 끝났나」를 답하는 것은
      //    이쪽이다.
      log(
        `버전 ${revisionNo} 빌드 완료 (${Math.round((Date.now() - startedAt) / 1000)}초).`,
      );
      return true;
    case "failed": {
      log(
        `버전 ${revisionNo} 빌드 실패${outcome.reason ? `\n${outcome.reason}` : ""}`,
      );
      const choice = await vscode.window.showErrorMessage(
        say.buildFailed(tenant, revisionNo),
        ...(outcome.reason ? ["자세히 보기"] : []),
      );
      if (choice === "자세히 보기") output.show();
      return false;
    }
    case "timeout":
      void vscode.window.showWarningMessage(
        say.buildTimedOut(tenant, revisionNo),
      );
      return false;
    case "cancelled":
      log(
        `버전 ${revisionNo} 기다리기를 그만뒀습니다 — 빌드는 서버에서 계속됩니다.`,
      );
      void vscode.window.showInformationMessage(
        say.buildWaitCancelled(tenant, revisionNo),
      );
      return false;
    case "superseded":
      // 빌드는 성공했다. **게시만 안 됐다** — 「배포했습니다」로 접으면 거짓이 나간다.
      log(
        `버전 ${countJosa(revisionNo, "은/는")} 다 만들어졌지만 그 사이 다른 판이 켜져 게시되지 않았습니다.`,
      );
      void vscode.window.showWarningMessage(
        say.supersededByOther(tenant, revisionNo),
      );
      return false;
    case "gone":
      void vscode.window.showWarningMessage(say.buildGone(tenant, revisionNo));
      return false;
  }
}

/**
 * E1·E2 — 에이전트가 이 사이트를 도구로 다룰 수 있게 설정 파일에 한 줄 적어 준다.
 *
 * **우리가 대신 로그인해 주지 않는다.** 첫 사용 때 에이전트가 브라우저로 직접 로그인한다(그 편이 정직하고,
 * 우리가 남의 에이전트의 토큰을 들고 있지 않게 된다).
 */
async function connectAgent(): Promise<void> {
  const dir = requireWorkspace();
  const config = await ensureHandshake();
  if (!config.mcp) {
    throw new DevtoolsError(
      "SERVER_REJECTED",
      "이 서버는 아직 에이전트 연결을 열지 않았습니다.",
      "잘커라에 문의해 주세요.",
    );
  }
  await ensureApi(); // 테넌트를 고르게 한다(아직 안 골랐다면).
  const tenant = tenantCode();

  // 서버가 준 값이라도 그대로 고객 파일에 적지 않는다 — 이름은 **키**가 되어 동명 항목을 덮고,
  // 두 주소는 고객의 에이전트가 접속·로그인하러 가는 곳이다. 판정이 안 서면 **아무것도 안 적는다**
  // (매뉴얼과 달리 기본값으로 물러설 자리가 없다).
  const serverName = mcpServerName(config.mcp.serverName);
  const mcpUrl = httpUrl(
    config.mcp.sourceUrlTemplate.replace(
      "{tenantCode}",
      encodeURIComponent(tenant),
    ),
  );
  const metadataUrl = httpUrl(config.mcp.authServerMetadataUrl);
  if (!serverName || !mcpUrl || !metadataUrl) {
    throw new DevtoolsError(
      "SERVER_REJECTED",
      "서버가 보낸 에이전트 연결 정보를 쓸 수 없습니다.",
      "설정을 바꾸지 않았습니다. 잘커라에 문의해 주세요.",
    );
  }

  const result = await registerMcpServer(dir, {
    serverName,
    url: mcpUrl.toString(),
    clientId: config.mcp.clientId,
    authServerMetadataUrl: metadataUrl.toString(),
  });
  const docs = await ensureAgentDocs(dir);

  log(
    `.mcp.json ${result.action === "created" ? "생성" : result.action === "updated" ? "갱신" : "변경 없음"} — ${result.path}`,
  );
  if (docs.agents === "created")
    log("AGENTS.md 스텁을 만들었습니다(규약 정본은 llms.txt 를 가리킵니다).");
  if (docs.claude === "created")
    log("CLAUDE.md 를 만들었습니다(AGENTS.md 를 참조하는 한 줄).");

  void vscode.window.showInformationMessage(
    "에이전트 설정을 적었습니다. 에이전트를 다시 열면 이 사이트 도구가 보이고, 처음 쓸 때 브라우저 로그인이 한 번 필요합니다.",
  );
}

/**
 * D5「이력」 — 버전 목록을 읽기 전용으로 보여 준다. 전환은 별도 명령(D4)이라 **여기서는 아무것도 바뀌지
 * 않는다** — 보러 들어왔다가 실수로 라이브를 바꾸는 일이 없어야 한다.
 */
async function showHistory(): Promise<void> {
  const api = await ensureApi();
  const revisions = await api.listRevisions();
  if (revisions.length === 0) {
    void vscode.window.showInformationMessage("아직 올린 버전이 없습니다.");
    return;
  }

  output.show();
  log("── 버전 이력 ──");
  for (const r of revisions) {
    const when = revisionWhen(r.createdAt);
    log(
      `${r.isActive ? "▶" : " "} 버전 ${r.revisionNo} · ${r.status} · ${when}${
        r.label ? ` · ${plainNotice(r.label, 80)}` : ""
      }`,
    );
  }
  log(`(총 ${revisions.length}개 · 바꾸려면 「버전 전환」을 쓰세요)`);
}

/** F2 — 문서 하나를 보고 진단을 갱신한다. 우리 프로젝트 밖 파일은 보지 않는다. */
function refreshDiagnostics(doc: vscode.TextDocument): void {
  const dir = workspaceDir();
  if (!dir || doc.uri.scheme !== "file" || !doc.uri.fsPath.startsWith(dir))
    return;
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(doc.uri.fsPath)) return;

  const text = doc.getText();
  const found = [
    ...diagnose(doc.uri.fsPath, text),
    ...diagnoseClientUsage(text, clientExports(dir)),
  ];
  diagnostics.set(
    doc.uri,
    found.map((f) => {
      const range = new vscode.Range(
        f.line,
        f.column,
        f.line,
        f.column + f.length,
      );
      const severity =
        f.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;
      const diagnostic = new vscode.Diagnostic(range, f.message, severity);
      diagnostic.source = "잘커라";
      diagnostic.code = f.rule;
      return diagnostic;
    }),
  );
}

/**
 * 설치된 `@zalkera/client` 가 **실제로 내보내는 이름**을 읽는다. 목록을 우리가 들고 있으면 client 가 성장할
 * 때마다 어긋나고, 그 어긋남이 고객에게는 "잘커라 도구가 틀렸다"로 보인다. 못 읽으면 빈 배열 — 아무 말도 안 한다.
 */
function clientExports(projectDir: string): string[] {
  const cached = clientExportCache.get(projectDir);
  if (cached) return cached;
  try {
    const dts = join(
      projectDir,
      "node_modules",
      "@zalkera",
      "client",
      "dist",
      "index.d.ts",
    );
    if (!existsSync(dts)) return [];
    const text = readFileSync(dts, "utf8");
    const names = new Set<string>();
    for (const match of text.matchAll(
      /export\s+(?:declare\s+)?(?:type|interface|class|function|const)\s+(\w+)/g,
    )) {
      if (match[1]) names.add(match[1]);
    }
    for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const raw of (match[1] ?? "").split(",")) {
        const name = raw
          .split(" as ")
          .pop()
          ?.trim()
          .replace(/^type\s+/, "");
        if (name) names.add(name);
      }
    }
    const list = [...names];
    clientExportCache.set(projectDir, list);
    return list;
  } catch {
    return [];
  }
}

const clientExportCache = new Map<string, string[]>();

/**
 * F1 — 되돌리기 어려운 자리를 **종류마다 한 번** 알린다.
 *
 * 부르는 자리가 둘이다: 사람이 타이핑을 시작할 때(그 자리에서 `isDirty` 를 본다)와,
 * 그 파일을 **열 때**. 둘째가 있어야 «디스크에 직접 쓰는 손»(에이전트·git)이 만든 변화를
 * 사람이 알 기회가 남는다 — 그 손은 편집 알림을 깨끗한 문서로 내기 때문이다.
 */
function warnProtectedPath(doc: vscode.TextDocument): void {
  const dir = workspaceDir();
  if (!dir || doc.uri.scheme !== "file" || !doc.uri.fsPath.startsWith(dir))
    return;
  const relative = doc.uri.fsPath.slice(dir.length + 1);
  const kind = protectedPathKind(relative);
  const advice = protectedPathWarning(relative);
  if (kind === null || advice === null) return;
  if (warnedThisSession.has(kind)) return;
  const seen = warnedKinds(kind);
  if (seen.has(kind)) {
    warnedThisSession.add(kind);
    return;
  }
  seen.add(kind);
  warnedThisSession.add(kind);
  void stateFor(kind).update(WARNED_KINDS_STATE, [...seen]);
  // 파일 이름은 **서버가 준 꾸러미의 항목명**에서 올 수 있다 — 우리가 지은 이름이 아니다.
  // 조언 문면은 우리 표에서 온다(`diagnostics.ts` 의 상수) — 그래서 표기만 붙인다.
  void vscode.window.showWarningMessage(
    `${plainNotice(relative, 120)} — ${ours(advice)}`,
  );
}

// ── 진단 ────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const dir = workspaceDir();
  const checks = await runDoctor({
    apiBase: apiBase(),
    extensionVersion,
    ...(dir ? { projectDir: dir } : {}),
  });
  const runtime = embeddedNodeRuntime(extensionPath);
  output.show();
  log("── 진단 ──");
  {
    // ⚠ **경로까지 찍는다.** "동봉 npm 있음" 만으로는 신고를 받았을 때 어느 바이너리가 돌았는지
    //   물어볼 수 없다. 설정값·고른 결과·사유를 한 자리에 남긴다.
    const pref = npmPreference();
    const npm = resolveNpm(
      extensionPath,
      pref,
      npmBlindSpots(session?.projectDir),
    );
    log(
      `${npm.kind === "unavailable" ? "❌" : "✅"} npm(설정 ${pref}): ${describeNpm(npm)}`,
    );
    log(`   → ${npm.why}`);
    if (npm.kind === "unavailable") log(`   → ${npm.hint}`);
  }
  for (const check of checks) {
    log(`${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`);
    if (check.hint) log(`   → ${check.hint}`);
  }
}

// ── 공통 ────────────────────────────────────────────────────────────────

/**
 * 핸드셰이크를 한 번 받아 캐시한다(F3). **로그인·API 호출보다 먼저** — 계약이 깨졌으면 여기서 끊어야
 * 사용자가 엉뚱한 원인(로그인 실패)을 쫓지 않는다.
 */
async function ensureHandshake(): Promise<Handshake> {
  if (handshake) return handshake;
  handshake = await fetchHandshake(apiBase(), extensionVersion);
  if (handshake.verdict === "UPGRADE_RECOMMENDED" && handshake.message) {
    // ⚠ **하루 한 번.** `ensureHandshake` 는 명령마다 불린다 — 억제가 없으면 창을 열 때마다,
    //   버튼을 누를 때마다 같은 알림이 뜬다. 새 권고 버전은 즉시 말한다.
    const key = "zalkera.upgradeNotice";
    const last = persistedState.get<UpgradeNoticeState>(key) ?? null;
    const target = handshake.recommendedExtensionVersion;
    // ⚠ `target` 을 **문장에 넣는다.** `shouldShowUpgradeNotice` 가 판 표기 형태를 강제하므로
    //   여기 도달한 값은 우리가 아는 모양이다 — 그 확인 없이 넣으면 서버가 문장을 쓰게 된다.
    if (shouldShowUpgradeNotice(target, last, Date.now())) {
      void persistedState.update(key, { version: target, shownAt: Date.now() });
      // Marketplace 를 우리가 조회하지 않는다(중복 UI · 새 실패 모드). 확장 뷰의 그 항목으로
      // 데려다 주기만 한다 — 설치·서명 판단은 VS Code 의 일이다.
      // **문장은 우리가 쓴다.** 서버 글자를 알림 본문에 얹으면, 그 글자를 정하는 쪽이 우리 이름으로
      // 뜨는 화면을 쓰게 된다(경계에서 소독은 하지만, 안 쓰는 편이 낫다). 서버 문장은 출력 채널에 남긴다.
      log(`서버 안내: ${handshake.message}`);
      const upgradeLine = `새 판이 있습니다(권고 ${target}). 지금 판은 ${extensionVersion} 입니다.`;
      // 바로 위에서 **우리가 조립한** 문장이다 — 서버 글자는 출력 채널에만 남긴다.
      void vscode.window
        .showInformationMessage(ours(upgradeLine), "업데이트")
        .then((picked) => {
          if (picked === "업데이트") {
            void vscode.commands.executeCommand(
              "workbench.extensions.search",
              `@id:${extensionId}`,
            );
          }
        });
    }
  }
  return handshake;
}

/**
 * 작업할 사이트를 고른다. **명령으로도, 곁다리로도 같은 경로**를 쓴다 — 두 벌이면 한쪽만 고쳐진다.
 *
 * @param force 이미 고른 사이트가 있어도 다시 묻는다(사이드바에서 바꾸려고 누른 경우).
 */
async function chooseTenant(force = false): Promise<string> {
  const config = await ensureHandshake();
  // ⚠ **취소를 삼키고 계속 가지 않는다.** 종전에는 `signIn()` 이 취소를 조용히 흡수하고 정상
  //    반환해서, 곁다리로 뜬 로그인을 취소하면 「취소했습니다」 토스트 **직후에** 아래 흐름이
  //    그대로 굴러 `getAccessToken` 이 터지고 **빨간 오류창**("로그인이 필요합니다")이 떴다.
  //    이 레포가 세워 둔 「취소는 오류가 아니다」가 정확히 여기서 깨졌다.
  //    `register()` 가 CANCELLED 를 조용히 로그로 처리하므로, 여기서는 끊기만 하면 된다.
  if (!(await store.read()) && !(await signIn())) {
    throw new DevtoolsError("CANCELLED", "로그인을 취소했습니다.");
  }

  const current = tenantCode();
  if (current && !force) return current;

  const api = new ZalkeraApi({
    apiBase: apiBase(),
    accessToken: () => getAccessToken(config.auth, store),
    tenantCode: () => "",
  });
  const { tenants, isSuperAdmin } = await api.whoAmI();
  // 여기가 목록을 쥐는 유일한 자리다 — 사이드바가 「전환」을 말해도 되는지를 여기서만 알 수 있다.
  // 본사 계정은 코드를 직접 쳐서 어디로든 가므로 언제나 전환 가능하다.
  void persistedState.update(CAN_SWITCH_STATE, isSuperAdmin || tenants.length > 1);

  // **목록이 비었다고 "사이트가 없다"가 아니다.** 서버는 소속(admin_user_tenant)만 열거하는데,
  // SUPER_ADMIN 은 소속과 무관하게 전 테넌트를 다룬다(`AdminUserAuth.canAccessTenant`).
  // 그 둘을 뭉뚱그리면 다 할 수 있는 사람에게 "권한이 없다"고 말하게 된다(실사용 신고).
  if (tenants.length === 0) {
    if (!isSuperAdmin) {
      throw new DevtoolsError(
        "FORBIDDEN",
        "이 계정에 연결된 사이트가 없습니다.",
        "잘커라 콘솔에서 사이트에 초대되었는지 확인해 주세요.",
      );
    }
    const typed = await vscode.window.showInputBox({
      title: "작업할 사이트 코드",
      prompt: "본사 관리자 계정입니다 — 사이트 코드를 직접 입력하세요.",
      placeHolder: "예: credium",
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.trim())
          ? undefined
          : "영문 소문자·숫자·하이픈만 씁니다.",
    });
    if (!typed)
      throw new DevtoolsError("CANCELLED", "사이트를 고르지 않았습니다.");
    const code = typed.trim();

    // **저장 전에 실재를 확인한다.** 형식만 맞으면 통과시키면, 오타 하나가 저장된 뒤
    // 미리보기·발행에서 엉뚱한 오류로 튀어나온다 — 그때는 원인이 "설정에 적힌 코드"라는 걸
    // 사용자가 알 방법이 없다. 읽기 전용 호출 하나로 여기서 끝낸다.
    const probe = new ZalkeraApi({
      apiBase: apiBase(),
      accessToken: () => getAccessToken(config.auth, store),
      tenantCode: () => code,
    });
    try {
      await probe.listRevisions();
    } catch (error) {
      throw new DevtoolsError(
        "NOT_A_SITE",
        `'${code}' 사이트를 찾지 못했습니다.`,
        "사이트 코드를 다시 확인해 주세요. 잘커라 콘솔의 주소에서 볼 수 있습니다.",
        error,
      );
    }

    await saveTenant(code);
    return code;
  }
  // 하나뿐이어도 **바꾸려고 부른 경우엔 보여 준다** — 안 보여 주면 누른 사람이 무시당했다고 느낀다.
  const picked =
    tenants.length === 1 && !force
      ? tenants[0]
      : await vscode.window
          .showQuickPick(
            tenants.map((t) => ({
              label: t.name,
              // ⚠ **지금 작업 중이라는 사실은 `description` 으로 간다.** 형제 화면
              //    (`describeOption`)이 세운 규칙과 같다 — `detail` 줄은 **경로 한 가지**만
              //    말한다. 종전에는 이 표시가 `detail` 을 차지해, **지금 열려 있는 사이트만**
              //    폴더를 확증해 두었어도 그 경로가 안 보였다 — 하필 자기가 서 있는 줄이다.
              description: t.code === current ? `${t.code} (작업 중)` : t.code,
              // ⚠ **어디가 열릴지 고르기 전에 보여 준다.** 종전에는 고른 **뒤에** 토스트로
              //    물었는데, 그 알림은 사라지고 경로도 안 보였다 — 잘못 골랐는지 알 방법이 없었다.
              //
              // ⚠ **지금 사이트도 레지스트리에서 읽는다.** 「지금 열린 창의 폴더」로 지으면,
              //    소속을 안 적은 폴더에서 열었을 때 그 경로가 남의 사이트 줄에 붙는다 —
              //    [confirmedFolderFor] 는 그 폴더가 **스스로 그 사이트라고 말할 때만** 답한다.
              detail: confirmedFolderFor(t.code) ?? undefined,
              // 🔴 **고른 것을 표시 문자열로 되찾지 않는다.** 종전에는 `description` 이 곧
              //    사이트 코드라 그것으로 찾았는데, 그 줄에 한 글자라도 덧붙이는 순간 조회가
              //    빗나가 **모든 선택이 「사이트를 고르지 않았습니다」로 죽는다.** 표시는 언제든
              //    다듬는 자리다 — 식별자를 거기에 실으면 문면 수정이 기능을 깬다.
              tenant: t,
            })),
            { title: "어느 사이트로 작업할까요?" },
          )
          .then((choice) => choice?.tenant);
  if (!picked)
    throw new DevtoolsError("CANCELLED", "사이트를 고르지 않았습니다.");

  await saveTenant(picked.code);
  return picked.code;
}

/** 사이드바·팔레트에서 부르는 사이트 선택. 취소는 조용히 끝낸다. */
async function chooseSite(): Promise<void> {
  try {
    // ⚠ **둘 다 고르기 전에 읽는다.** `chooseTenant` 가 설정을 쓰고 나면 소속도 유효 사이트도
    //    오염된다 — 특히 `current` 는 늘 고른 값과 같아져 모든 전환이 「이미 그 사이트」로 접힌다.
    const binding = currentFolderBinding();
    const current = tenantCode();
    const code = await chooseTenant(true);
    const choice = decideSiteChoice({
      picked: code,
      binding,
      siteFolderOpen: siteDir() !== null,
      current,
    });
    await refreshSidebar();
    // `code`·`binding` 은 서버·폴더가 정한 값이다 — 소독 없이 알림에 넣으면 비-모달이 명령
    // 링크로 렌더한다(재심의 실증).
    if (choice.kind === "unchanged") {
      // **아무것도 안 바뀌었다.** 「바꿨습니다」로 말하면 화면과 실제가 갈린다.
      void vscode.window.showInformationMessage(say.alreadyOnSite(code));
      return;
    }
    if (choice.kind === "switched") {
      log(`작업 사이트를 ${code} 로 바꿨습니다.`);
      void vscode.window.showInformationMessage(`사이트: ${plainNotice(code, 64)}`);
      return;
    }
    if (choice.kind === "adopted") {
      log(`이 폴더를 ${code} 사이트에 연결했습니다.`);
      // 잘못 고른 사람에게 **되돌리는 길**을 준다 — 입양은 조용히 일어나고, 그 사실만 알리면
      // 다음에 할 일이 화면에 없다. 막지는 않는다(표식 부재로는 아무것도 막지 않는다).
      const RELINK = "다시 연결";
      if ((await vscode.window.showInformationMessage(say.folderAdopted(code), RELINK)) === RELINK) {
        await vscode.commands.executeCommand("zalkera.site.link");
      }
      return;
    }
    // `elsewhere` 는 소속이 있을 때만 나온다 — 빈 문자열로 물러설 자리가 아니다.
    await offerElsewhere(code, binding ?? "");
  } catch (error) {
    if (isCancelled(error)) return;
    throw error;
  }
}

/**
 * 고른 사이트가 **이 폴더의 것이 아닐 때** 무엇을 할지 고르게 한다.
 *
 * ⚠ **이 창의 사이트는 바뀌지 않았다**(`decideTenantScope` 가 `none` 이라 아무것도 안 적혔다).
 *   그러니 「바꿨습니다」로 말하면 안 된다 — 화면과 실제가 갈린다.
 *
 * ⚠ **알림이 아니라 고르는 화면이다.** 알림은 단추 두셋이 한계이고 저절로 사라진다 — 여기서
 *   내야 할 길은 그보다 많고, 사라지면 사람은 자기가 고른 것이 무시당했다고 읽는다. Esc 가 곧
 *   취소이고, 그때 아무것도 안 적히는 것은 위 `none` 판정이 이미 담보한다.
 */
async function offerElsewhere(picked: string, binding: string): Promise<void> {
  log(`이 폴더는 ${binding} 사이트에 연결돼 있어 ${picked} 작업은 다른 폴더에서 합니다.`);
  // 고른 사이트를 **여기서 잡는다.** 이 창의 유효 사이트는 아직 이 폴더의 것이라, 캡처 없이
  // 부르면 받기가 엉뚱한 사이트의 소스를 내려받는다.
  const pinned = captureTenant(picked);
  const confirmedDir = confirmedFolderFor(picked);

  const quick = vscode.window.createQuickPick<
    vscode.QuickPickItem & { option: ElsewhereOption }
  >();
  let settled = false;
  try {
    // ⚠ **리스너를 `show()` 앞에 단다.** VS Code 의 `Event<void>` 는 재생하지 않는다 — 화면이
    //    뜬 뒤에 달면 그 사이의 `onDidHide` 를 아무도 못 듣고, 프라미스가 영영 안 풀려
    //    `finally` 의 `dispose()` 까지 안 돈다(명령 하나가 끝나지 않고 위젯이 쌓인다).
    //    `onDidHide` 는 Esc 만이 아니라 **다른 입력 UI 가 열리는 것만으로도** 발화한다.
    const decided = new Promise<ElsewhereOption | undefined>((resolve) => {
      quick.onDidAccept(() => resolve(quick.selectedItems[0]?.option));
      quick.onDidHide(() => resolve(undefined));
    });
    quick.title = say.elsewhereTitle(picked, binding);
    quick.ignoreFocusOut = true;
    quick.placeholder = "무엇을 할지 고르세요";
    // ⚠ **기다리지 않고 그린다.** 조회를 앞세우면 흔한 칸에서도 빈 목록을 보게 되는데, 그렇게
    //    벌 수 있는 것은 「판 없는 사이트에서 받기 한 줄을 뺄 기회」뿐이다(시한을 넘기면 어차피
    //    그 줄이 남는다). 먼저 그리고, 조회가 그 줄을 빼야 한다고 말할 때만 다시 그린다.
    quick.items = optionItems(elsewhereOptions({ confirmedDir, fetchable: "unknown" }).options);
    quick.show();

    // ⚠ **이 폴더가 선언하는 판은 «로컬»이라 지금 읽는다.** 네트워크가 아니므로 화면을 안 붙든다.
    //    `holdsSameRevision` 이 아니라 `declaredBaseRevisionNo` 다 — 우리가 말하려는 것은 「이
    //    폴더가 그 판의 사본이다」가 아니라 **「이 판을 딛고 작업했다」**이고, 그 폴더는 받기 표식이
    //    아니라 **발행 표식**을 들고 있을 수 있다(내가 올린 뒤 남이 또 올린 흔한 형상).
    const heldRevisionNo =
      confirmedDir === null ? null : declaredBaseRevisionNo(readSourceMarkAt(confirmedDir), String(picked));

    void probeFetchable(pinned).then(({ fetchable, serverRevisionNo }) => {
      // 사람이 이미 고르거나 닫았으면 손대지 않는다 — 버려진 위젯을 만지면 던진다.
      if (settled) return;
      const { options, note } = elsewhereOptions({
        confirmedDir,
        fetchable,
        heldRevisionNo,
        serverRevisionNo,
      });
      // ⚠ **「말할 것이 생겼을 때」만 다시 그린다.** 종전에는 `yes` 를 통째로 건너뛰었는데, 판이
      //    **있는** 사이트가 바로 이 고지가 설 자리다. 반대로 말할 것이 없으면 안 그린다 — 다시
      //    그리면 포커스가 첫 칸으로 돌아가므로, 흔한 칸에서 공짜로 그럴 이유가 없다.
      const drift = options.some((o) => o.kind === "open" && o.drift !== null);
      if (note === null && !drift) return;
      if (note !== null) {
        quick.placeholder =
          note === "no-ready" ? say.noReadySourceYet(picked) : say.noSourceYet(picked);
      }
      quick.items = optionItems(options);
    });

    const chosen = await decided;
    settled = true;
    quick.hide();
    if (!chosen) return;
    // ⚠ **위젯을 먼저 놓는다.** 받기·폴더 열기는 수 분 돌 수 있고, 그동안 숨은 위젯을 붙들고
    //    있을 이유가 없다.
    quick.dispose();
    await runElsewhere(chosen, pinned, picked);
  } finally {
    settled = true;
    quick.dispose();
  }
}

/** 순수 판정이 낸 항목을 화면 항목으로. 라벨은 리터럴, 서버·로컬 값은 `detail` 로만 간다. */
function optionItems(
  options: ElsewhereOption[],
): (vscode.QuickPickItem & { option: ElsewhereOption })[] {
  return options.map((option) => ({ ...describeOption(option), option }));
}

/**
 * 그 사이트에서 **받을 수 있는가.**
 *
 * ⚠ **모르는 것으로는 막지 않는다.** 조회가 실패하면 `unknown` 이고 받기 항목은 남는다 — 서버가
 *   잠시 흔들린 것을 「소스가 없다」로 접으면 정상 경로가 사라진다.
 *
 * ⚠ **「없다」를 두 사유로 가른다**(`noRevisionError` 와 같은 갈래). 빌드가 도는 사이트의 사용자에게
 *   「소스가 없으니 zip 으로 시작하라」고 하면 잠시 기다리면 될 사람을 엉뚱한 길로 보낸다.
 *
 * 화면을 막지 않으므로 상한은 **늦게 온 답을 버리는 선**일 뿐이다. 제어 평면 상한(30초)을 그대로
 * 쓰면 그만큼 타이머가 살아 있게 되므로 짧게 끊고, 이긴 쪽이 정해지면 타이머를 지운다.
 *
 * ⚠ **소비자가 둘이고 걸린 것이 다르다.** 「버전 전환」의 `withProbeDeadline` 도 이 상수를 쓰는데
 *   그 자리는 **화면을 막는다** — 위 첫 줄이 그쪽에는 안 맞는다. 그래서 이 값을 올리면
 *   **차단 자리의 최악 대기가 함께 올라간다.** 프로브 사정으로 올리고 싶어지면 그 자리에 별도
 *   상수를 두십시오 — 지금 이 값을 30초로 되돌리면 전건 초록인 채 그 회귀가 난다(설계자 심의).
 */
const FETCHABLE_PROBE_MS = 4_000;

/**
 * 조회 하나로 **둘**을 안다 — 받을 판이 있는가, 그리고 그 판이 몇 번인가.
 *
 * ⚠ **번호를 버리지 않는다.** 종전에는 `pickRevision` 까지 돌리고 결과를 세 값짜리 enum 으로
 *   접어 버렸다. 그래서 화면이 「이 폴더는 버전 3, 서버는 9」를 말하려면 **같은 조회를 한 번 더**
 *   해야 했고, 그것은 이 화면에 새 인증 호출을 얹는 일이라 안 하기로 한 축이다
 *   (`DESIGN-server-replace.md` §9 「원격 새 판 감시」). 이미 손에 든 답을 그대로 내보낸다.
 */
async function probeFetchable(
  pinned: CapturedTenant,
): Promise<{
  fetchable: "yes" | "no-revision" | "no-ready" | "unknown";
  serverRevisionNo: number | null;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { api } = await ensureApiFor(pinned);
    const revisions = await Promise.race([
      api.listRevisions(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FETCHABLE_PROBE_MS);
      }),
    ]);
    if (revisions === null) {
      log("사이트의 판 목록을 제때 받지 못해 받기 항목을 그대로 둡니다.");
      return { fetchable: "unknown", serverRevisionNo: null };
    }
    if (revisions.length === 0) return { fetchable: "no-revision", serverRevisionNo: null };
    const picked = pickRevision(revisions);
    if (picked === null) return { fetchable: "no-ready", serverRevisionNo: null };
    return { fetchable: "yes", serverRevisionNo: picked.revisionNo };
  } catch (error) {
    log(
      `사이트의 판 목록을 확인하지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`,
    );
    return { fetchable: "unknown", serverRevisionNo: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 항목의 라벨은 **리터럴**이다 — 서버 값은 `detail` 로만 간다.
 *
 * ⚠ **「그 사이트」를 붙이지 않는다.** 제목이 이미 어느 사이트인지 이름으로 말하고, 항목마다
 *   그것을 「그」로 되받으면 정관사를 옮긴 번역투가 된다. 이름은 사이드바의 같은 동작
 *   (「소스 다운로드」)과 맞춘다 — 같은 일에 두 이름을 두지 않는다.
 */
function describeOption(option: ElsewhereOption): vscode.QuickPickItem {
  switch (option.kind) {
    case "open":
      return {
        label: "$(folder-opened) 폴더 열기",
        // ⚠ **`detail`(경로)은 건드리지 않는다.** 「보인 것과 여는 것이 같아야 한다」는 계약이
        //    그 줄에 걸려 있다(`folderStillShown`). 새 사실은 `description` 으로 간다.
        //
        // ⚠ **방향을 단정하지 않는다.** 되돌린 사이트에서는 로컬이 서버보다 앞이라 「낡았다」가
        //    거짓이 된다 — 번호 둘만 말하고 판단은 사람이 한다.
        // ⚠ **정수만 싣는다.** 서버 문자열이 이 줄에 오면 QuickPick 라벨 소독 구멍
        //    (`DECISIONS.md` 열린 쟁점)을 넓히게 된다.
        description:
          option.drift === null
            ? undefined
            : `버전 ${option.drift.held} · 서버는 버전 ${option.drift.server} — 「서버 판으로 교체」로 맞출 수 있습니다`,
        detail: plainNotice(option.dir, 120),
      };
    case "fetch":
      return {
        label: "$(cloud-download) 소스 다운로드",
        detail: "새 빈 폴더에 받습니다 — 지금 폴더는 그대로 둡니다",
      };
    case "pick-folder":
      return {
        label: "$(search) 로컬본 폴더 직접 고르기…",
        detail: "이미 받아 두신 폴더가 있으면 그것을 엽니다",
      };
    case "import-zip":
      return {
        label: "$(file-zip) 받은 zip 으로 시작…",
        detail: "새 빈 폴더에 zip 을 풉니다",
      };
  }
}

async function runElsewhere(
  option: ElsewhereOption,
  pinned: CapturedTenant,
  picked: string,
): Promise<void> {
  switch (option.kind) {
    case "open": {
      // 확증은 목록을 만들 때도 했지만 **누른 시점에 다시 한다** — 그 사이 폴더가 사라지거나
      // 다른 사이트를 담게 됐을 수 있고, 그때 여는 것이 이 설계가 막으려는 사고다.
      const dir = confirmedFolderFor(picked);
      // ⚠ **보인 것과 여는 것이 같아야 한다.** `null` 만 보면, 목록을 띄운 사이 다른 창이
      //    레지스트리를 바꿨을 때 `detail` 에 적힌 것과 **다른 폴더**가 말없이 열린다 —
      //    형제 자리(`작업 폴더 변경`)가 이미 같은 잣대를 쓴다. 한쪽만 고치면 갈린다.
      if (!folderStillShown(dir, option.dir)) {
        // ⚠ **「소스 다운로드」로 보내지 않는다.** 이 안내가 뜨는 순간 사이트를 캡처한 목록은 이미
        //    닫혔고, 화면에 남은 같은 이름의 버튼은 **무캡처 배선**이라 이 창의 유효 사이트를
        //    받는다 — 방금 고른 사이트가 아니다. 캡처를 쥔 여기서 바로 제안한다.
        const RETRY = "새로 받기";
        const answer = await vscode.window.showInformationMessage(
          ours(`받아 두신 폴더를 더는 찾지 못했습니다 — ${picked} 의 소스를 새로 받으시겠습니까?`),
          RETRY,
        );
        if (answer === RETRY) await openSite(pinned);
        return;
      }
      await openSiteFolder(dir);
      return;
    }
    case "fetch":
      // 가드는 여기서 안 잡는다 — `openSite` 안쪽의 해제 구간이 잡는다(`whileExtracting`).
      await openSite(pinned);
      return;
    case "pick-folder":
      await openPickedLocalFolder(pinned, picked);
      return;
    case "import-zip":
      // ⚠ **맨몸 명령으로 이탈하지 않는다.** 그 문은 로그인만 요구하고 사이트를 모르므로, 방금
      //    고르신 사이트가 여기서 버려졌다 — 푼 폴더가 어느 사이트 것인지 아무 데도 안 적혔고
      //    사람이 「사이트에 연결」로 같은 선택을 한 번 더 해야 했다(형제 `fetch` 갈래는 처음부터
      //    `pinned` 를 들고 간다). 팔레트의 맨몸 문은 그대로 남는다 — 그 문의 정체성은
      //    `whyBlocked` 의 `["signedIn"]` 요건이다.
      await importZipCommand(pinned);
      return;
  }
}

/**
 * 「로컬본 폴더 직접 고르기」 — 사람이 아는 자리를 우리가 못 기억할 때의 길.
 *
 * ⚠ **이 동사는 재연결이 아니다.** 소속이 있는 폴더는 열지 않고 거절한다 — 남의 사이트 소스를
 *   「그 사이트 폴더」로 내주지 않는 것은 레지스트리 확증과 같은 잣대다. 소속을 **바꾸는** 것은
 *   「사이트에 연결」 하나로 남는다.
 */
async function openPickedLocalFolder(
  pinned: CapturedTenant,
  picked: string,
): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "이 폴더 열기",
    title: `「${picked}」 의 소스 폴더 고르기`,
  });
  const dir = chosen?.[0]?.fsPath;
  if (dir === undefined) return;

  const plan = decidePickedFolder(
    folderBinding(readSourceMarkAt(dir), workspaceLinkAt(dir)),
    picked,
  );
  if (plan.kind === "refuse") {
    void vscode.window.showWarningMessage(
      say.pickedFolderBoundElsewhere(plan.bound, picked),
    );
    return;
  }
  if (plan.kind === "link-consent") {
    // ⚠ **소스인지 말해 준다 — 막지는 않는다.** 동의 문면이 「이 폴더의 소스가 그 사이트로
    //    올라가게 됩니다」라고 소스임을 전제하는데, 확인 없이 그러면 바탕화면을 고른 사람에게도
    //    같은 말을 하고 그 폴더를 레지스트리에 「그 사이트 폴더」로 확증 등재한다.
    //    표식 부재로 막지 않는 것과 **없는 사실을 지어내지 않는 것**은 다른 이야기다.
    const ask = say.pickedFolderLinkConfirm(picked);
    const looksLikeSource = existsSync(join(dir, "package.json"));
    const answer = await vscode.window.showWarningMessage(
      ask.message,
      {
        modal: true,
        detail: looksLikeSource ? ask.detail : `${ask.detail}\n${ask.notSourceNote}`,
      },
      ask.action,
    );
    // ⚠ **취소하면 열지도 않는다.** 연결 없이 열면 새 창의 유효 사이트가 전역 잔값이 되어,
    //    소속 없는 폴더 + 잘못된 유효 사이트라는 형상을 우리 제안이 만들어 준다.
    if (answer !== ask.action) return;
    await markFolderLinked(dir, String(pinned));
  }
  // 링크는 두 갈래 모두 쓴다 — `open` 은 표식에 맞추는 복원이고, 연결은 표식과 짝이다.
  const linked = await linkFolderToTenant(dir, String(pinned));
  if (!linked.ok) log(`폴더 설정을 적지 못했습니다(${linked.reason}).`);

  // ⚠ **동의를 받고도 못 썼으면 열지 않는다.** 위 취소 가드의 근거(「연결 없이 열면 소속 없는
  //    폴더 + 잘못된 유효 사이트를 우리가 만들어 준다」)는 「동의했는데 실패했다」에도 그대로
  //    적용된다. 주석에 쓴 이유를 취소에만 걸어 두면 그 근거가 반쪽이 된다.
  //    JSONC 주석이 섞인 `settings.json`·못 쓰는 `.zalkera` 에서 실제로 밟힌다.
  if (folderBinding(readSourceMarkAt(dir), workspaceLinkAt(dir)) === null) {
    void vscode.window.showWarningMessage(say.pickedFolderNotLinked(picked));
    return;
  }
  rememberFolder(String(pinned), dir);
  await openSiteFolder(dir);
}

async function ensureApi(): Promise<ZalkeraApi> {
  return (await ensureApiFor()).api;
}

/**
 * API 와 **그 API 가 묶인 테넌트**를 함께 준다.
 *
 * ⚠ **표기는 동작이 묶인 테넌트를 적어야 한다**(심의 차단 · 2026-08-10). 종전에는 알림이 그리는
 * 시점에 `tenantCode()` 를 다시 읽었는데, 그 사이 사용자가 사이트를 바꿀 수 있다 — 빌드 대기는 수
 * 분이고 모달이 아니라서 사이드바가 열려 있다. 그러면 **A 에 올린 버전을 「B」라고 적고**, 「지금
 * 전환」이 실제로 B 를 전환한다(리비전 번호는 테넌트별 순번이라 겹친다).
 *
 * 사이트 이름을 적어 안심시키려던 트랜치가, 틀린 이름으로 **오인을 보증**하는 자리가 된다.
 */
async function ensureApiFor(
  pinned?: CapturedTenant,
): Promise<{ api: ZalkeraApi; tenant: CapturedTenant }> {
  const config = await ensureHandshake();
  // **여기가 유일한 캡처 지점이다.** 브랜드가 붙는 자리가 늘어나면 그것이 방어가 느슨해지는 신호다.
  // `pinned` 는 **이미 캡처된 값**을 되쓰는 것이라 캡처 지점을 늘리지 않는다 — 자동 갱신이
  // 「그때 그 사이트」로 다시 서게 하려는 것이다.
  const tenant = pinned ?? captureTenant(await chooseTenant());

  return {
    tenant,
    api: new ZalkeraApi({
      apiBase: apiBase(),
      accessToken: () => getAccessToken(config.auth, store),
      tenantCode: () => tenant,
    }),
  };
}

const API_BASE_DEFAULT = "https://api.zalkera.com";

/**
 * npm 을 찾을 때 **보지 말아야 할 자리.** 열어 둔 폴더와 지금 다루는 소스 폴더가 온다.
 *
 * 이 도구의 기본 동작이 「남이 준 zip 을 풀어 그 폴더에서 명령을 돌리는 것」이라, 그 폴더는 언제나
 * 적대적일 수 있다고 본다. PATH 에 그 폴더 안쪽 항목이 들어와 있으면(직접 열린 터미널·direnv 등)
 * npm 찾기가 **그 폴더 안의 파일**을 집을 수 있다.
 */
function npmBlindSpots(projectDir?: string): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(
    (f) => f.uri.fsPath,
  );
  return [...folders, ...(projectDir ? [projectDir] : [])].filter(
    (d) => d.length > 0,
  );
}

/**
 * 어느 npm 으로 설치할지의 사용자 선택. **머신 범위**라 남의 소스 폴더가 못 바꾼다 —
 * `apiBase` 와 같은 이유이고, 여기서는 **우리가 실행할 바이너리**가 걸려 있어 더 직접적이다.
 */
function npmPreference(): NpmPreference {
  const raw = vscode.workspace.getConfiguration("zalkera").get<string>("npm");
  return raw === "system" || raw === "auto" ? raw : "bundled";
}

/**
 * 서버 주소. **https 이거나 루프백**이어야 한다 — 이 주소가 준 값들이 로그인·에이전트 연결을
 * 지시하므로, 뿌리가 평문이면 중간에 앉은 쪽이 나머지를 전부 바꿔 쓴다.
 *
 * 설정 스키마의 `pattern` 만으로는 부족하다 — **이미 저장된 값**은 스키마를 다시 안 지난다.
 */
function apiBase(): string {
  const configured = vscode.workspace
    .getConfiguration("zalkera")
    .get<string>("apiBase");
  if (configured === undefined || configured.trim() === "")
    return API_BASE_DEFAULT;
  const url = apiBaseUrl(configured);
  if (url) return url.toString();
  throw new DevtoolsError(
    "SERVER_REJECTED",
    `설정한 서버 주소를 쓸 수 없습니다(${configured}).`,
    "https 주소이거나 로컬(127.0.0.1)이어야 합니다. 설정 zalkera.apiBase 를 고쳐 주세요.",
  );
}

/**
 * 고른 사이트를 적는다. **범위 판정은 core 가 한다**(`decideTenantScope`).
 *
 * ⚠ **소속이 다른 폴더에서는 아무것도 적지 않는다.** 폴더 링크를 덮으면 그 폴더가 자기를 남의
 *   사이트라고 말하게 되고, 전역에 적으면 그 값이 표식도 링크도 없는 폴더를 여는 순간 되살아나
 *   게이트가 설 수 없는 자리에서 교차 업로드가 된다.
 */
async function saveTenant(code: string): Promise<void> {
  const scope = decideTenantScope({
    siteFolderOpen: siteDir() !== null,
    binding: currentFolderBinding(),
    chosen: code,
  });
  const target = configTargetFor(scope);
  if (target === undefined) return;
  await vscode.workspace.getConfiguration("zalkera").update("tenant", code, target);
}

/**
 * 범위 → VS Code 쓰기 대상. `none` 은 **대상이 없다**.
 *
 * ⚠ **삼항으로 쓰지 마라.** `scope === "workspace" ? Workspace : Global` 은 `none` 을 조용히
 *   전역으로 흘려보낸다 — 판정을 부르고도 결과를 무시하는 형상이고, 그 한 줄이 §4.3 넷째 행이
 *   막는 전역 오염을 통째로 되살린다(심의 실증: 그 변이가 전건 초록으로 살아남았다).
 *   전수 `switch` 는 칸을 지우면 타입이 먼저 선다.
 */
function configTargetFor(scope: TenantScope): vscode.ConfigurationTarget | undefined {
  switch (scope) {
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "global":
      return vscode.ConfigurationTarget.Global;
    case "none":
      return undefined;
    default: {
      // 칸을 지우면 여기서 타입이 선다 — 남은 값이 `never` 가 아니게 된다.
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

/**
 * 고른 사이트를 지운다. **두 범위 모두** — 한쪽만 지우면 남은 쪽이 되살아난다.
 *
 * 워크스페이스 범위는 폴더가 열려 있을 때만 쓸 수 있다(없으면 VS Code 가 던진다).
 */
async function clearTenantSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration("zalkera");
  await config.update("tenant", undefined, vscode.ConfigurationTarget.Global);
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    await config.update(
      "tenant",
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }
}

/**
 * 이 창에 **사이트 소스**가 열려 있는가. 폴더만 있는 것과 다르다.
 *
 * ⚠ **판정이 하나여야 한다.** 사이드바와 요건 게이트가 서로 다른 기준을 쓰면, 사이드바는
 *   「소스 없음」으로 그리는데 게이트는 통과시켜 사람이 눌렀다가 안쪽에서 다른 말로 막힌다.
 *   실제로 게이트만 `workspaceDir()` 을 봤다(심의 권고).
 */
function siteDir(): string | null {
  const dir = workspaceDir();
  return dir && existsSync(join(dir, "package.json")) ? dir : null;
}

function tenantCode(): string {
  return (
    vscode.workspace.getConfiguration("zalkera").get<string>("tenant") ?? ""
  );
}

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function requireWorkspace(): string {
  const dir = workspaceDir();
  if (!dir) {
    throw new DevtoolsError(
      "NOT_A_SITE",
      "열린 폴더가 없습니다.",
      "사이트 소스 폴더를 먼저 여세요(파일 → 폴더 열기).",
    );
  }
  return dir;
}

/** 사이드바가 보여 줄 사실만 다시 읽는다 — 판정이 아니라 표시다. */
async function refreshSidebar(): Promise<void> {
  const dir = workspaceDir();
  // ⚠ **상태바도 같이 갱신한다.** 종전에는 사이드바만 새로 그려, 사이트를 바꾸거나 폴더로
  //    돌아온 뒤에도 상태바가 낡은 사이트를 말했다 — 경고를 눌러 되돌려도 경고가 그대로였다.
  //    화면 둘이 같은 사건을 보게 하는 것이 이 한 줄이다(미리보기 중에는 그쪽이 자리를 쓴다).
  if (session === null) showIdleStatus();
  sidebar.update({
    signedIn: (await store.read()) !== null,
    tenant: tenantCode(),
    site: siteDir(),
    // ⚠ **게이트와 같은 값을 본다**(`announceIfBlocked`). 둘이 다른 기준을 쓰면 사이드바는
    //    건강해 보이는데 누르면 막히는, 이 레포가 이미 한 번 겪은 형상이 된다.
    folderTenant: currentFolderBinding(),
    // ⚠ **게이트가 보는 그 값 하나에서 나와야 한다**(`workspaceDir()`). 화면이 다른 경로를
    //    말하면 「이 폴더」의 지시대상이 또 갈린다 — 이 값을 세우는 이유가 바로 그 갈림을 없애는
    //    것이다.
    folderPath: dir ?? null,
    // 모름(`null`)과 「하나뿐」(`false`)은 다른 값이다 — 접으면 여럿 맡은 사람이 자리를 잃는다.
    canSwitch: canSwitchCached(),
    // 기계마다 다른 값이라 판정이 스스로 읽지 않는다 — 여기서 넘긴다(`sidebarPlan` 의 KDoc).
    home: homedir(),
  });
}

/**
 * 미리보기가 안 도는 창의 상태바를 지금 상태로 맞춘다. **판정은 core 가 한다**(`idleStatusPlan`).
 *
 * ⚠ 어긋남 술어를 여기서 다시 쓰지 않는다 — 게이트·사이드바와 갈리면 화면마다 다른 말을 한다.
 */
function showIdleStatus(): void {
  const plan = idleStatusPlan({
    tenant: tenantCode(),
    folderTenant: currentFolderBinding(),
    site: siteDir(),
  });
  status.text = plan.text;
  status.tooltip = plan.tooltip;
  status.backgroundColor = plan.warning
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  status.command = plan.warning ? "zalkera.site.useFolder" : "zalkera.preview.start";
}

function setStatus(text: string): void {
  status.text = text;
  status.tooltip = session
    ? `미리보기 실행 중 — ${session.server.url}`
    : "잘커라 미리보기 시작";
  // ⚠ **경고 상태를 되돌린다.** `showIdleStatus` 가 켠 배경·명령이 남아 있으면, 미리보기가
  //    도는데도 상태바가 주황으로 남고 누르면 엉뚱한 명령이 돈다.
  status.backgroundColor = undefined;
  status.command = "zalkera.preview.start";
}

function log(message: string): void {
  output.appendLine(message);
}
