/**
 * **`vscode.git` 을 읽는 자리** — 확장이 git 에 관해 아는 전부가 여기서 온다(`doc/DESIGN-git-coexistence.md`).
 *
 * ■ git 명령을 직접 돌리지 않는다
 *   VS Code 동봉 Git 확장이 이미 레포를 열고, 상태를 감시하고, 명령을 돌린다. 우리는 그 API
 *   (`extensions/git/src/api/git.d.ts` · `getAPI(1)`)로 **읽기만** 하고, 쓰는 것은 태그 하나뿐이며
 *   그것도 사람이 단추를 누른 뒤다. git 이 꺼져 있거나 없거나 폴더가 레포가 아니면 **`null`** —
 *   그때 확장은 종전과 똑같이 돈다.
 *
 * ■ 형은 우리가 쓰는 만큼만 적는다
 *   상류 `git.d.ts` 를 통째로 들여오지 않는다 — 사본은 낡고, 우리가 기대는 것은 필드 대여섯 개다.
 *   상류 서명(2026-09-14 조회): `Repository.state: {HEAD?: Branch; workingTreeChanges; indexChanges;
 *   untrackedChanges}` · `status(): Promise<void>` · `tag(name, message, ref?)`.
 *   ⚠ **`ref` 는 VS Code 1.107 부터다.** 우리 engine 은 `^1.90.0` 이라 그 전 판에서는 셋째 인자가
 *   **조용히 무시되고 HEAD 에 찍힌다**(기능 심의 실측). 그래서 태그를 만드는 쪽은 `ref` 에 기대지 않고
 *   **누르는 순간의 HEAD 가 그 커밋인지 다시 읽어** 확인한다(`extension.ts` `createGitTag`).
 *
 * ■ 모르면 `null` 이다
 *   `git status` 가 실패했거나(`index.lock`·`safe.directory`) 확장 활성화가 시한 안에 안 끝나면 낡은
 *   상태로 「깨끗함」을 그리지 않는다 — 줄도 단추도 없는 쪽이 옳다. 폴더 설정 `git.untrackedChanges`
 *   가 `hidden` 이면 미추적이 **어느 배열에도 안 와서** 수를 알 수 없다(`-uno`) — 그 설정은 폴더의
 *   `.vscode/settings.json` 이 정할 수 있는 값이라, 남이 만든 폴더가 우리 화면을 「깨끗함」으로 만들 수
 *   있다. 그때 `uncommitted` 는 `null`(셀 수 없음)이다.
 */
import * as vscode from "vscode";
import { countUncommitted, type GitSnapshot } from "@zalkera/devtools-core";

interface GitChange {
  readonly uri: vscode.Uri;
}
interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
}
interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly workingTreeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly untrackedChanges: readonly GitChange[];
}
/** 우리가 기대는 `Repository` 의 조각. */
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  status(): Promise<void>;
  /** 셋째 인자(찍을 커밋)는 1.107+ 에서만 듣는다 — 위 KDoc. */
  tag(name: string, message: string, ref?: string): Promise<void>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/** git 확장 활성화를 기다리는 상한. 넘기면 「없는 것」으로 본다 — 확인 창이 말없이 굳는 것보다 낫다. */
const ACTIVATE_TIMEOUT_MS = 5_000;
/**
 * `git status` 를 기다리는 상한. `status()` 는 git 프로세스 예닐곱을 돌리고(성능 심의 · `repository.ts`
 * `updateModelState`) 리눅스 16k 파일에서 30ms 지만 윈도·큰 모노레포에서는 초 단위다. 넘기면 **모름**(`null`)
 * — 낡은 값으로 「깨끗함」을 그리지 않는다.
 */
const STATUS_TIMEOUT_MS = 3_000;

/** `promise` 가 시한 안에 안 끝나면 `fallback`. 시한은 창을 굳히지 않으려는 것이지 판정이 아니다. */
function within<T>(ms: number, promise: PromiseLike<T>, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** 폴더를 품은 레포. 없으면 `null` — git 확장이 없거나 꺼졌거나 레포가 아니다. */
export async function gitRepositoryAt(dir: string): Promise<GitRepository | null> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return null;
  // 아직 안 켜졌을 수 있다(활성화는 지연된다). 켜는 데 실패하거나 시한을 넘기면 **없는 것**으로 본다.
  const exports = ext.isActive
    ? ext.exports
    : await within(ACTIVATE_TIMEOUT_MS, ext.activate().then((e) => e, () => undefined), undefined);
  if (!exports?.enabled) return null;
  try {
    return exports.getAPI(1).getRepository(vscode.Uri.file(dir));
  } catch {
    return null;
  }
}

/**
 * 레포의 지금 상태를 **한 번 새로 읽어** 접는다. `status()` 가 `git status` 를 돌리므로 확인 창
 * 직전에 부르면 그 순간의 사실이다(감시 지연 뒤의 낡은 값이 아니라). **못 읽으면 `null`** — 낡은
 * 상태로 「깨끗함」을 그리지 않는다(위 KDoc).
 *
 * 폴더 안 판정·중복 제거는 core 의 [countUncommitted] 가 한다(순수 함수 · 시험이 문다).
 */
export async function gitSnapshotOf(repo: GitRepository, dir: string): Promise<GitSnapshot | null> {
  const fresh = await within(STATUS_TIMEOUT_MS, repo.status().then(() => true, () => false), false);
  if (!fresh) return null;
  const hidden =
    vscode.workspace.getConfiguration("git", vscode.Uri.file(dir)).get<string>("untrackedChanges") === "hidden";
  const all = [repo.state.workingTreeChanges, repo.state.indexChanges, repo.state.untrackedChanges].flatMap(
    (list) => list.map((c) => c.uri.fsPath),
  );
  const head = repo.state.HEAD;
  return {
    branch: head?.name ?? null,
    commit: head?.commit ?? null,
    uncommitted: hidden ? null : countUncommitted(dir, all),
  };
}

/** [gitRepositoryAt] + [gitSnapshotOf] 를 한 번에 — 부르는 자리가 셋이라 묶는다. 레포가 아니면 `null`. */
export async function readGit(dir: string): Promise<{ repo: GitRepository; snapshot: GitSnapshot } | null> {
  const repo = await gitRepositoryAt(dir);
  if (repo === null) return null;
  const snapshot = await gitSnapshotOf(repo, dir);
  return snapshot === null ? null : { repo, snapshot };
}
