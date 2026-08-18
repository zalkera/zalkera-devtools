import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 소스를 받을 폴더가 **비어 있는가**를 판정한다.
 *
 * ■ 왜 `readdir().length === 0` 이 아닌가 (실사용 신고 · 2026-08-10)
 *   폴더를 연 창에서 사이트를 고르면 VS Code 가 워크스페이스 설정을 쓰면서 **`.vscode/settings.json` 을
 *   만든다.** 그러면 방금 만든 빈 폴더가 "비어 있지 않음"이 되어 소스를 못 받는다 — **도구가 만든 파일
 *   때문에 도구가 막히는** 자물쇠다. 오너가 폴더를 지우고 다시 만들어도 같은 일이 반복됐다.
 *
 * ■ 무엇을 무시하고 무엇을 막는가
 *   무시하는 것은 **소스가 아닌 것**뿐이다 — 편집기 설정과 OS 부스러기. 사람이 만든 파일이 하나라도
 *   있으면 그대로 막는다. 이 가드의 목적은 **고치던 소스를 서버 버전으로 조용히 밀어 버리지 않는 것**
 *   이고, 그 목적은 여기서도 그대로 선다.
 *
 *   ⚠ **`.git` 은 무시하지 않는다.** 그 폴더가 이미 어떤 레포라는 뜻이고, 그 위에 남의 소스를 푸는 것은
 *   이력을 가진 작업물을 덮는 일이다. 무시 목록에 넣고 싶은 유혹이 있지만 그건 다른 종류의 손실이다.
 *
 *   ⚠ **무시는 이름이 아니라 종류로 정한다 — 심링크는 절대 무시하지 않는다.** 이름만 보면 `.vscode`
 *   라는 이름의 **링크**가 "빈 폴더"를 통과하고, 그 링크가 해제 대상 경로가 된다. 무시의 근거는
 *   *"편집기가 만든 파일"* 이지 *"그 이름"* 이 아니다 — 편집기는 링크를 만들지 않는다.
 */
const IGNORED = new Set([
    ".vscode", // 편집기·확장이 만든다(우리가 만드는 쪽이다)
    ".DS_Store", // macOS
    "Thumbs.db", // Windows
    "desktop.ini", // Windows
]);

/**
 * **우리가 만들다 만 임시 자리.** 소스 받기가 `mkdtemp(targetDir, ".zalkera-fetch-")` 로 만든다.
 *
 * ⚠ **무시가 아니라 청소다.** 다운로드는 최대 15분이고 그 사이에 확장 호스트가 죽으면(창 닫기·
 *   크래시·절전) 잔해가 남는다. 그것은 점으로 시작해 `ls` 에 **안 보이는데**, 그 폴더는 그 뒤
 *   모든 「소스 받기」에서 「비어 있지 않습니다」로 막힌다 — 고객 눈에 그 폴더는 비어 있다.
 *   안내문은 "빈 폴더를 고르세요"인데 이미 빈 폴더다. 되돌아갈 길이 없는 형상이다(마감 심의 차단).
 *
 *   [IGNORED] 에 넣어 **무시**하면 그 잔해가 소스 트리에 영원히 남는다. 우리가 만든 것이니
 *   우리가 지운다.
 */
export const OUR_SCRATCH_PREFIX = ".zalkera-fetch-";

/** 우리가 남긴 임시 자리를 걷어낸다. 없으면 아무 일도 안 한다. */
/**
 * 이 폴더에 우리 임시 자리가 있는가. `{swept, active}` — **지운 수**와 **아직 살아 있는 수**다.
 *
 * ⚠ **살아 있는 것과 죽은 것을 반드시 가른다.** 이름 접두만 보고 다 지웠더니, 같은 폴더로 두 번째
 *   받기를 시작한 순간 **진행 중인 첫 번째의 임시 파일이 사라져** 첫 번째가 ENOENT 로 죽고, 그
 *   실패의 롤백이 두 번째가 푼 파일까지 걷어 갔다. 사용자에게는 「1개 파일을 받았습니다」가 뜨고
 *   폴더는 **비어 있었다**(실측). 다운로드는 최대 15분이고 취소 단추가 없어 「멈춘 것 같다」며 다시
 *   누르는 것이 유일한 대응이라, 그 형상이 곧 정상 사용 경로다.
 *
 *   이 폴더는 **자물쇠 노릇도 한다** — 살아 있는 것이 있으면 부르는 쪽이 그렇게 말해야 한다.
 *
 * 판정은 **가장 최근에 손댄 시각**으로 한다: 전송 상한(15분)보다 오래됐으면 그 받기는 이미 죽었다.
 */
/**
 * **받을 폴더를 원자적으로 점유한다.** 성공하면 `release()` 를, 이미 누가 잡고 있으면 `null` 을 준다.
 *
 * ■ 왜 «자물쇠» 여야 하나
 *   종전에는 임시 폴더의 **존재**가 우연히 뮤텍스 노릇을 했다. 잔해 청소를 넣으며 그것을 걷어냈고,
 *   대신 「살아 있는 스크래치가 있으면 물러난다」는 **판정**을 두었다. 그것은 자물쇠가 아니라
 *   **표지판**이다 — 판정과 점유 사이에 fs 호출이 여럿 있어, 두 실행이 **둘 다** 「비어 있다」를
 *   본다. 실측: 같은 이벤트루프 턴에 두 받기가 들어오면 100% 충돌했고, 먼저 것의 롤백이 나중 것이
 *   푼 파일까지 걷어 가 **「받았습니다」가 뜨고 폴더는 비었다.**
 *
 *   `mkdir` 은 POSIX·Windows 모두 **원자**다. 있으면 `EEXIST` 로 실패한다. 판정과 점유가 한 호출이라
 *   틈이 없다 — 이 성질이 필요한 자리에서는 그것을 쓰는 것이 정석이다.
 *
 * ■ 죽은 자물쇠를 어떻게 아는가
 *   시각이 아니라 **주인**으로 안다. 자물쇠 안에 `pid` 와 시작 시각을 적고, 같은 기계라면
 *   `process.kill(pid, 0)` 이 주인의 생사를 바로 말해 준다. 크래시 잔해는 **기다릴 필요 없이 즉시**
 *   회수된다 — mtime 휴리스틱은 최대 15분을 기다리게 했고(아무도 안 받는데 「이미 받는 중입니다」),
 *   해제가 길어지면 **살아 있는 받기를 죽은 것으로** 판정하기도 했다(실측).
 *
 *   주인이 다른 기계이거나(공유 폴더) 판독 불가면 **시작 시각**으로 물러난다 — 그때만 시간이 쓰인다.
 */
export interface FolderLock {
    /**
     * 이 받기가 쓰는 **작업 자리**. 자물쇠 **안**이다.
     *
     * 임시물을 자물쇠 밖에 따로 두면 청소할 것이 둘이 되고, 크래시 잔해가 「비어 있는가」 판정에
     * 걸려 폴더를 눈에 안 보이게 막는다 — 그것을 이름 규칙과 시각 휴리스틱으로 걷으려다 살아 있는
     * 받기를 죽였다(실측). 자물쇠 안에 두면 **회수가 한 번**이고, 그 회수는 주인의 생사로 판정한다.
     */
    readonly workDir: string;
    release(): Promise<void>;
}

const LOCK_NAME = ".zalkera-fetch-lock";

export async function acquireFolderLock(dir: string, staleAfterMs: number): Promise<FolderLock | null> {
    const lockDir = join(dir, LOCK_NAME);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDir); // 원자 — 있으면 EEXIST
            await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
            const workDir = join(lockDir, "work");
            await mkdir(workDir, { recursive: true });
            return {
                workDir,
                release: async () => void (await rm(lockDir, { recursive: true, force: true }).catch(() => {})),
            };
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
            if (attempt > 0 || !(await isDeadLock(lockDir, staleAfterMs))) return null;
            // 주인이 죽었다 — 한 번만 회수하고 다시 잡아 본다. 두 번째 EEXIST 는 남이 먼저 잡은 것이다.
            await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
    }
    return null;
}

/** 자물쇠의 주인이 이미 죽었는가. */
async function isDeadLock(lockDir: string, staleAfterMs: number): Promise<boolean> {
    let owner: { pid?: unknown; startedAt?: unknown };
    try {
        owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as typeof owner;
    } catch {
        // 주인 표식을 못 읽는다 — **자물쇠가 만들어지다 만 것**이거나 남의 것이다.
        // 시각으로 물러난다. 못 읽는 이유로 폴더가 **영구히** 막히면 안 된다(그것이 종전 형상이다).
        return await olderThan(lockDir, staleAfterMs);
    }
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
            process.kill(owner.pid, 0);
            return false; // 살아 있다
        } catch (cause) {
            // ESRCH = 그런 프로세스 없음(죽었다) · EPERM = 남의 것(살아 있다)
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") return true;
            return false;
        }
    }
    return await olderThan(lockDir, staleAfterMs);
}

/** 이 자물쇠가 만들어진 지 오래됐는가 — 주인을 못 물을 때만 쓴다. */
async function olderThan(lockDir: string, staleAfterMs: number): Promise<boolean> {
    try {
        const info = await stat(lockDir);
        return Date.now() - info.mtimeMs > staleAfterMs;
    } catch {
        return true; // 자물쇠 자체를 못 읽는다 — 막힌 채 두는 것보다 회수를 시도하는 편이 낫다
    }
}

/**
 * 자물쇠는 「비어 있는가」 판정에서 뺀다 — 우리 것이지 고객 것이 아니다.
 *
 * 임시물이 전부 이 안에 살므로, 크래시 잔해도 이 이름 **하나**다. 고객에게는 안 보이고, 다음
 * 회차가 주인의 생사를 물어 즉시 회수한다 — 15분을 기다리지 않는다.
 */
export function isOurLockName(name: string): boolean {
    return name === LOCK_NAME;
}

/**
 * **우리가 쓴 것만** 되감는다.
 *
 * 형제 [removeAdded] 는 「해제 전에 없던 것」을 지우는데, 그 기준선은 받기 **시작 전** 한 번만
 * 찍힌다. 다운로드가 최대 15분이라 그 사이에 고객이 만든 파일이 함께 사라진다 — VS Code 가
 * 폴더를 연 창에서 `.vscode/settings.json` 을 만드는 것도 그 창 안이다(실측으로 둘 다 사라졌다).
 *
 * 그래서 되감을 대상을 **해제기가 직접 알려 준 이름**으로 좁힌다([UntarOptions.onWroteRoot]).
 */
export async function removeWritten(dir: string, names: Iterable<string>): Promise<void> {
    for (const name of new Set(names)) {
        if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
        await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
}

/** 무시 대상을 뺀 실제 항목. 비어 있으면 받아도 안전하다. */
export async function meaningfulEntries(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
        .filter((e) => !isOurLockName(e.name))
        .filter((e) => !(IGNORED.has(e.name) && !e.isSymbolicLink()))
        .map((e) => e.name);
}

export async function isReceivable(dir: string): Promise<boolean> {
    return (await meaningfulEntries(dir)).length === 0;
}

/**
 * 해제 **전** 폴더에 있던 이름들. 실패했을 때 «우리가 쓴 것» 만 되감기 위한 기준선이다.
 *
 * ⚠ [meaningfulEntries] 가 **일부러 통과시키는 것**([IGNORED])이 있다는 사실이 여기서 결정적이다.
 *   `.vscode` 는 「빈 폴더」 판정을 통과하고 배송 문서도 "있어도 괜찮습니다"라고 초대한다. 그런데
 *   롤백이 폴더를 통째로 지우면 **그 초대에 응한 고객의 파일이 사라진다**(실측: 손으로 만든
 *   `.vscode/launch.json` 이 지워졌다). 이 도구가 낼 수 있는 가장 큰 손해가 그것이다.
 */
export async function snapshotEntries(dir: string): Promise<Set<string>> {
    try {
        return new Set(await readdir(dir));
    } catch {
        return new Set(); // 아직 없는 폴더 — 우리가 만들 것이므로 기준선은 비어 있다
    }
}

/**
 * 기준선 이후에 **생긴 것만** 지운다. 폴더 자체는 남긴다 — 고객이 고른 자리다.
 *
 * 지우다 실패해도 던지지 않는다. 이 함수는 이미 실패한 경로에서 불리고, 여기서 또 던지면
 * **원래 오류가 가려진다** — 사용자는 무엇이 잘못됐는지 못 듣게 된다.
 */
export async function removeAdded(dir: string, before: Set<string>): Promise<void> {
    let now: string[];
    try {
        now = await readdir(dir);
    } catch {
        return;
    }
    for (const name of now) {
        if (before.has(name)) continue;
        await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
}
