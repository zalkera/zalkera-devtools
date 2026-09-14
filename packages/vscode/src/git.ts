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
 */
import { isAbsolute, relative, sep } from "node:path";
import * as vscode from "vscode";
import type { GitSnapshot } from "@zalkera/devtools-core";

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
  tag(name: string, message: string): Promise<void>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/** 폴더를 품은 레포. 없으면 `null` — git 확장이 없거나 꺼졌거나 레포가 아니다. */
export async function gitRepositoryAt(dir: string): Promise<GitRepository | null> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return null;
  // 아직 안 켜졌을 수 있다(활성화는 지연된다). 켜는 데 실패하면 **없는 것**으로 본다.
  const exports = ext.isActive ? ext.exports : await ext.activate().then((e) => e, () => undefined);
  if (!exports?.enabled) return null;
  try {
    return exports.getAPI(1).getRepository(vscode.Uri.file(dir));
  } catch {
    return null;
  }
}

/**
 * 레포의 지금 상태를 **한 번 새로 읽어** 접는다. `status()` 가 `git status` 를 돌리므로 확인 창
 * 직전에 부르면 그 순간의 사실이다(감시 지연 뒤의 낡은 값이 아니라).
 *
 * ⚠ **이 폴더 아래만 센다.** 레포 뿌리가 폴더보다 위(모노레포)면 형제 패키지의 변경은 이 폴더의
 *   발행과 무관하다 — 그것까지 세면 「커밋하지 않은 변경 40개」가 남의 이야기가 된다.
 * ⚠ **경로로 중복을 뺀다.** 스테이지된 뒤 또 고친 파일은 `indexChanges` 와 `workingTreeChanges` 에
 *   둘 다 온다. 두 번 세면 수가 거짓이다.
 */
export async function gitSnapshotOf(repo: GitRepository, dir: string): Promise<GitSnapshot> {
  await repo.status().catch(() => undefined);
  const inside = (c: GitChange): boolean => {
    const rel = relative(dir, c.uri.fsPath);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const paths = new Set<string>();
  for (const list of [repo.state.workingTreeChanges, repo.state.indexChanges, repo.state.untrackedChanges]) {
    for (const c of list) if (inside(c)) paths.add(c.uri.fsPath);
  }
  const head = repo.state.HEAD;
  return {
    branch: head?.name ?? null,
    commit: head?.commit ?? null,
    uncommitted: paths.size,
  };
}

/** [gitRepositoryAt] + [gitSnapshotOf] 를 한 번에 — 부르는 자리가 셋이라 묶는다. 레포가 아니면 `null`. */
export async function readGit(dir: string): Promise<{ repo: GitRepository; snapshot: GitSnapshot } | null> {
  const repo = await gitRepositoryAt(dir);
  if (repo === null) return null;
  return { repo, snapshot: await gitSnapshotOf(repo, dir) };
}
