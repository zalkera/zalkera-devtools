import { readdir, rm } from "node:fs/promises";
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
const OUR_SCRATCH_PREFIX = ".zalkera-fetch-";

/** 우리가 남긴 임시 자리를 걷어낸다. 없으면 아무 일도 안 한다. */
export async function sweepOurScratch(dir: string): Promise<number> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return 0; // 폴더가 없거나 못 읽는다 — 부르는 쪽이 판정한다
    }
    let swept = 0;
    for (const entry of entries) {
        // 심링크는 안 따라간다 — 이름만 흉내 낸 링크가 우리 지우개를 밖으로 끌고 갈 수 있다.
        if (!entry.name.startsWith(OUR_SCRATCH_PREFIX) || entry.isSymbolicLink()) continue;
        await rm(join(dir, entry.name), { recursive: true, force: true }).catch(() => {});
        swept += 1;
    }
    return swept;
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
