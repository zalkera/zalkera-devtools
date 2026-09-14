/**
 * **git 과 맞물리는 자리의 순수 판정**(`doc/DESIGN-git-coexistence.md`).
 *
 * ■ 확장은 git 을 모른 채로 맞물린다
 *   여기에는 git 명령도 GitHub 호출도 없다. 있는 것은 셋뿐이다 — ⑴ 디스크의 어떤 변화가 판을 다시
 *   세게 하는가(감시기의 거름) ⑵ 되돌릴 수 없는 문 앞에 적을 git 한 줄 ⑶ 발행 뒤 태그를 권해도
 *   되는 조건. git 의 **사실**은 VS Code 의 `vscode.git` 확장이 읽어 [GitSnapshot] 으로 넘긴다 —
 *   core 는 VS Code 를 모르므로 읽는 쪽은 확장 패키지에 산다.
 *
 * ■ 판정 하나가 두 자리에 쓰인다
 *   감시기가 거르는 집합은 손 목록이 아니라 `hashWorkdir` 가 안 세는 것 그대로다([isExcludedEntry]).
 *   미리보기가 도는 동안 `.next/` 가 끊임없이 바뀌는데, 그것을 안 거르면 묶음 타이머가 매번
 *   되돌아가 **재계산이 영영 안 돈다**(기아). 「세지도 않는 파일이 재계산을 막는」 형상을 막으려면
 *   세는 술어와 거르는 술어가 같은 함수여야 한다.
 */
import {isAbsolute, relative, sep} from "node:path";
import {TENANT_CODE} from "./localMark.ts";
import {count, plainNotice} from "./notice.ts";
import {isExcludedEntry} from "./zip.ts";

// ⚠ `excludeFromGit` 은 **잎 모듈**에 산다 — `localMark.ts` 가 그것을 부르는데, 이 파일은 `zip.ts` 를
//    거쳐 `provenance.ts` → `localMark.ts` 로 되돌아오므로 여기 두면 순환이 된다(실측: 모듈 평가
//    순서가 갈려 `PROVENANCE_PATH` 초기화 전 접근으로 죽었다). 부르는 쪽은 잎에서 직접 가져간다.
export {excludeFromGit} from "./gitExclude.ts";

/**
 * `vscode.git` 이 말해 준 이 폴더의 git 상태 — **읽은 그대로**, 판정 없이.
 *
 * `branch` 는 분리 HEAD 면 `null`, `commit` 은 아직 커밋이 없는 레포면 `null`. `uncommitted` 는
 * 작업 트리·인덱스·미추적을 **합쳐 경로로 중복을 뺀** 수다 — `git.untrackedChanges` 설정에 따라
 * 미추적이 두 배열 중 어디로 오는지가 갈리므로, 합쳐야 어느 설정에서도 같은 수가 된다.
 *
 * ⚠ **`null` 은 「셀 수 없다」다.** `git.untrackedChanges: hidden`(`-uno`)·`git.ignoreSubmodules`
 *   (`--ignore-submodules`)이면 git 확장이 변경 일부를 **어느 배열에도 안 실어** 준다 — 그때 0 을 「깨끗함」이라
 *   말하면 거짓이다(보안 심의 실측 · Fable). 둘 다 폴더의 `.vscode/settings.json` 이 정할 수 있는 값이라 남이 만든
 *   폴더가 우리 화면을 「깨끗함」으로 만들 수 있다. 폴더를 레포 뿌리와 다른 대소문자로 열어 변경 경로가 폴더의
 *   하위로 안 잡히는 경우도 같다. 모르면 모른다고 적고, 태그는 권하지 않는다.
 */
export interface GitSnapshot {
    branch: string | null;
    commit: string | null;
    uncommitted: number | null;
}

/** 확인 창에 적을 한 줄. 레포가 아니면 **빈 문자열** — 「git 없음」은 판정이라 적지 않는다. */
export function gitStatusLine(git: GitSnapshot | null): string {
    if (git === null) return "";
    const short = git.commit === null ? null : plainNotice(git.commit.slice(0, 7), 7);
    const where =
        git.branch !== null && short !== null
            ? `${plainNotice(git.branch, 80)} @ ${short}`
            : short !== null
              ? `(분리됨) @ ${short}`
              : "아직 커밋 없음";
    const changes =
        git.uncommitted === null
            ? "커밋하지 않은 변경을 셀 수 없음(git 설정이 일부를 숨김)"
            : git.uncommitted > 0
              ? `커밋하지 않은 변경 ${count(git.uncommitted)}개`
              : "깨끗함";
    return `git: ${where} · ${changes}`;
}

/**
 * 이 상대 경로의 변화가 **판 지문을 바꿀 수 있는가.** 감시기는 참일 때만 재계산을 예약한다.
 *
 * 세지 않는 것(`node_modules`·`.next`·`.git`·우리 기록물·비밀 파일…)은 바뀌어도 지문이 그대로라
 * 예약할 이유가 없고, 예약하면 위 KDoc 의 기아가 온다.
 */
export function affectsFolderVersion(relative: string): boolean {
    const path = relative.split("\\").join("/");
    if (path === "" || path === "." || path.startsWith("../") || path === "..") return false;
    return !isExcludedEntry(path);
}

/** 발행 뒤 권할 태그. `ref` 는 **발행 시점의 커밋**이다 — 태그는 그 커밋에 찍혀야 한다. */
export interface TagOffer {
    name: string;
    message: string;
    ref: string;
}

/** git 이 내는 객체 이름의 모양 — SHA-1 40 · SHA-256 64. `ref` 자리에 이것 말고는 안 넘긴다. */
const COMMIT_SHAPE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * 발행이 끝난 뒤 「git 태그 만들기」를 **권해도 되는가.** 되면 이름·메시지·찍을 커밋, 아니면 `null`.
 *
 * 🔴 **깨끗한 트리에서만 권한다.** 발행이 올린 것은 HEAD 가 아니라 디스크의 파일이다. 커밋하지
 *    않은 변경이 있었으면 그 커밋은 라이브가 아닌 것을 가리키고, 그 태그는 거짓이다.
 *    커밋이 없는 레포도 가리킬 것이 없고, **셀 수 없으면**(`uncommitted === null`) 모르는 것이라 안 권한다.
 * 🔴 **`ref` 는 발행 시점의 커밋이다.** 누르는 순간의 HEAD 가 아니다 — 빌드 대기(분 단위) 사이에 커밋하면
 *    HEAD 는 이미 다른 것이고, 거기 찍은 태그는 버전 N 이 아닌 소스를 가리킨다(보안 심의 실측).
 */
export function tagOffer(git: GitSnapshot | null, tenant: string, revisionNo: number): TagOffer | null {
    if (git === null || git.commit === null || git.uncommitted === null || git.uncommitted > 0) return null;
    // `ref` 는 `git tag -a … <ref>` 의 마지막 인자다. 배열 인자라 셸 주입은 없지만 `-f` 같은 값이 오면 **강제
    // 덮어쓰기**가 된다 — 오늘 `HEAD.commit` 은 `rev-parse` 출력이라 도달 불가지만, 모양이 아니면 안 권한다(Fable 보안).
    if (!COMMIT_SHAPE.test(git.commit)) return null;
    if (!Number.isInteger(revisionNo) || revisionNo < 1) return null;
    // 이름에 사이트를 넣는다 — 한 레포로 여러 사이트를 돌리는 대행사에서 `zalkera/v5` 는 둘째 사이트부터
    // 「이미 있습니다」로 죽는다(기능 심의). 코드 모양은 ref 이름 규칙 안이라 그대로 쓴다 — 모양이 아니면 안 권한다.
    if (!TENANT_CODE.test(tenant)) return null;
    return {name: `zalkera/${tenant}/v${revisionNo}`, message: `잘커라 ${tenant} 버전 ${revisionNo}`, ref: git.commit};
}

/**
 * git 확장이 준 변경 경로들 중 **이 폴더 아래**의 것을 경로로 중복을 빼고 센다.
 *
 * ⚠ 레포 뿌리가 폴더보다 위(모노레포)면 형제 패키지의 변경은 이 폴더의 발행과 무관하다 — 그것까지
 *   세면 「커밋하지 않은 변경 40개」가 남의 이야기가 된다. 스테이지된 뒤 또 고친 파일은 두 목록에
 *   다 오므로 경로로 합친다.
 */
export function countUncommitted(dir: string, fsPaths: Iterable<string>): number {
    const seen = new Set<string>();
    for (const p of fsPaths) {
        const rel = relative(dir, p);
        if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) continue;
        seen.add(p);
    }
    return seen.size;
}
