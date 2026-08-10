import { readdir } from "node:fs/promises";

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
 */
const IGNORED = new Set([
    ".vscode", // 편집기·확장이 만든다(우리가 만드는 쪽이다)
    ".DS_Store", // macOS
    "Thumbs.db", // Windows
    "desktop.ini", // Windows
]);

/** 무시 대상을 뺀 실제 항목. 비어 있으면 받아도 안전하다. */
export async function meaningfulEntries(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter((name) => !IGNORED.has(name));
}

export async function isReceivable(dir: string): Promise<boolean> {
    return (await meaningfulEntries(dir)).length === 0;
}
