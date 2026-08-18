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
 * **우리가 쓴 것만** 되감는다.
 *
 * 형제 [removeAdded] 는 「해제 **전**에 없던 것」을 지운다. 그 기준선이 언제 찍히느냐가 전부다 —
 * 소스 받기에서는 다운로드 **전**에 찍혀 최대 15분의 창이 생겼고, 그 사이 고객이 만든 파일이
 * 함께 사라졌다(VS Code 가 폴더를 연 창에서 만드는 `.vscode/settings.json` 도 그 창 안이다).
 * `presets.ts` 는 다운로드 **뒤**에 찍어 그 창이 없으므로 [removeAdded] 를 그대로 쓴다.
 *
 * 여기서는 되감을 대상을 **해제기가 직접 알려 준 이름**으로 좁힌다([UntarOptions.onWroteRoot]) —
 * 「없던 것」은 「우리가 쓴 것」의 **근사**였고, 근사가 틀리는 창이 15분이었다.
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
