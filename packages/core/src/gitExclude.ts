/**
 * **git 이 우리 파일을 안 나르게 하는 잎 모듈.** `safeWrite.ts`(→ `errors.ts` → `notice.ts`) 밖에
 * 아무것도 안 가져온다 — `localMark.ts`(표식)와 `pull.ts`(장부)가 부르는데, 둘 다 `zip.ts` 의 배제
 * 목록이 거꾸로 의존하는 자리라 여기가 `zip.ts` 쪽 모듈을 가져오는 순간 순환이 된다(`git.ts` KDoc).
 */
import {chmod, lstat, readFile} from "node:fs/promises";
import {join} from "node:path";
import {ensureOwnDir, writeOwnFile} from "./safeWrite.ts";

/**
 * git 이 우리 파일을 안 나르게 한다 — `.git/info/exclude` 에 한 줄.
 *
 * ■ 목적은 유출 방지가 아니라 **거짓 상태 방지**다
 *   장부(`.zalkera/sync.json`)와 표식(`.zalkera/source.json`)에는 비밀이 없다. 다른 기계의 기준점이
 *   커밋을 타고 넘어오면 이 폴더는 자기가 안 한 일을 했다고 믿는다 — 「수정 중」·「서버가 더
 *   최신」이 남의 사실 위에서 판정된다.
 *
 * ■ 🔴 왜 `.gitignore` 가 아니라 `.git/info/exclude` 인가 — 실측으로 갈렸다
 *   `.gitignore` 는 **판이 싣고 오는 파일**이다(고객이 올린 zip 에 대개 들어 있다). 거기 한 줄을
 *   붙이면 그 파일은 곧바로 「판과 다른」 상태가 되고, **두 번째 받기부터 영구히 충돌한다** —
 *   고객이 만진 적도 없는 파일 이름을 대면서. `.git/info/exclude` 는 같은 효과를 내면서
 *   **커밋되지 않고 판에도 안 실린다**(`.git` 은 배제 목록에 있다). 도구가 자기 파일을 감추는
 *   표준 자리다.
 *
 * ■ git 폴더가 없으면 **아무것도 안 한다**
 *   막으려는 것이 「커밋을 타고 넘어오는 것」이므로 git 이 없으면 막을 것도 없다. 없는 자리에
 *   파일을 만들어 두면 그 파일이 다음 판에 실려 나간다. `.git` 이 **파일**인 경우(워크트리·
 *   서브모듈)도 건드리지 않는다 — 그 안쪽은 다른 자리에 있고 `mkdir` 이 실패한다.
 *
 * 던지지 않는다 — 이것은 부가이고, 못 해도 부른 쪽의 일(받기·표식 쓰기)은 이미 끝났다.
 */
export async function excludeFromGit(root: string, path: string): Promise<void> {
    try {
        // `lstat` — `.git` 이 **링크**면 그 너머는 남의 레포다. 거기 줄을 적는 것은 우리 폴더 밖 쓰기라
        // 하지 않는다(이 레포가 `.vscode`·`.zalkera` 에 대는 자와 같은 자). 파일(워크트리 gitdir)도 아니다.
        const info = await lstat(join(root, ".git")).catch(() => null);
        if (!info || !info.isDirectory()) return;
        // 조각마다 링크를 거절하며 만든다(`ensureOwnDir`) — `.git/info` 가 링크면 여기서 던지고 아래 catch 로 간다.
        const dir = await ensureOwnDir(root, ".git", "info");
        const file = join(dir, "exclude");
        // ⚠ **「없다」와 「못 읽는다」를 접지 않는다**(보안 심의 실측: 권한 없는 exclude 를 빈 파일로 읽고
        //    `rename` 으로 갈아 끼워 고객의 규칙이 통째로 사라졌다). 없으면 새로 만들고, 있는데 정규 파일이
        //    아니거나(FIFO 면 `readFile` 이 영영 멈춘다) 못 읽으면 **쓰지 않는다**. 모드는 있던 그대로 —
        //    `rename` 은 새 파일이라 `core.sharedRepository` 레포의 그룹 쓰기가 사라진다.
        const leaf = await lstat(file).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
            throw error;
        });
        if (leaf !== null && !leaf.isFile()) return;
        const current = leaf === null ? "" : await readFile(file, "utf8");
        if (current.split(/\r?\n/).some((line) => line.trim() === path)) return;
        const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
        // 잎이 링크면 거절하고, 아니면 `rename` 으로 갈아 끼운다 — 맨 `writeFile` 은 링크를 따라간다.
        const mode = leaf === null ? 0o644 : leaf.mode & 0o777;
        await writeOwnFile(file, `${current}${prefix}${path}\n`, mode);
        // `writeFile(tmp, {mode})` 는 umask 를 지나 0664 가 0644 로 좁아진다(2회전 보안 실측) — 있던 모드로 되돌린다.
        if (leaf !== null) await chmod(file, mode);
    } catch {
        // 부가다 — 위 KDoc. 링크 거절도 여기로 온다: 감추지 못한 표식은 커밋될 수 있지만 남의 파일을 쓰지는 않는다.
    }
}
