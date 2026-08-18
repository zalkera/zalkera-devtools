import { readdir, rm, stat } from "node:fs/promises";
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
export async function sweepOurScratch(dir: string, staleAfterMs: number): Promise<{ swept: number; active: number }> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return { swept: 0, active: 0 }; // 폴더가 없거나 못 읽는다 — 부르는 쪽이 판정한다
    }
    let swept = 0;
    let active = 0;
    for (const entry of entries) {
        // ⚠ **`mkdtemp` 가 만드는 모양만 본다** — 접두 + 무작위 6자 **디렉터리**. 접두만 보면
        //   고객이 둔 `.zalkera-fetch-메모.txt` 나 `.zalkera-fetch-내작업/` 을 지운다(실측).
        //   심링크는 안 따라간다 — 이름만 흉내 낸 링크가 우리 지우개를 폴더 밖으로 끌고 간다.
        if (!OUR_SCRATCH_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (!(await isStale(full, staleAfterMs))) {
            active += 1; // 누가 지금 받고 있다 — 건드리지 않는다
            continue;
        }
        try {
            await rm(full, { recursive: true, force: true });
            swept += 1; // ⚠ **성공만 센다.** 시도를 세면 「정리했습니다」 뒤에 「비어 있지 않습니다」가 온다(실측).
        } catch {
            /* 못 지웠다 — 부르는 쪽의 빈 폴더 판정이 그 사실을 말한다 */
        }
    }
    return { swept, active };
}

/** 접두 + `mkdtemp` 의 무작위 6자. 고객이 우연히 만들 이름이 아니다. */
const OUR_SCRATCH_NAME = /^\.zalkera-fetch-[A-Za-z0-9]{6}$/;

/** 이 받기가 죽었는가 — 안의 것 중 **가장 최근**에 손댄 시각으로 판정한다. */
async function isStale(dir: string, staleAfterMs: number): Promise<boolean> {
    let newest = 0;
    try {
        const info = await stat(dir);
        newest = info.mtimeMs;
        for (const name of await readdir(dir)) {
            const child = await stat(join(dir, name)).catch(() => null);
            if (child && child.mtimeMs > newest) newest = child.mtimeMs;
        }
    } catch {
        return false; // 못 읽으면 **살아 있는 것으로 본다** — 지우는 쪽으로 실패하지 않는다
    }
    return Date.now() - newest > staleAfterMs;
}

/** 무시 대상을 뺀 실제 항목. 비어 있으면 받아도 안전하다. */
export async function meaningfulEntries(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => !(IGNORED.has(e.name) && !e.isSymbolicLink())).map((e) => e.name);
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
