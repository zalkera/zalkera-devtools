import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { OWN_STATE_DIR, type Snapshot } from "./emptyDir.ts";
import { SOURCE_MARK_PATH, parseSourceMark, writeBindingMarkTo } from "./localMark.ts";
import { SYNC_LEDGER_PATH } from "./syncLedger.ts";

/**
 * 받기·zip 풀기가 **성공한 뒤**, 그 폴더에 원래 있던 우리 자기 상태 파일 중 **새 내용과 안 맞는 것**을 치운다.
 *
 * ■ 왜 있나
 *   「빈 폴더」 판정은 우리 표식·CLI 장부만 든 폴더를 통과시킨다(`emptyDir.ts`). 그러면 **옛 상태 파일이 든
 *   채로** 새 내용이 풀린다. 그대로 두면 옛 파일이 새 내용에 대해 거짓을 말한다:
 *   - 옛 표식이 「판 N 을 받았다」고 말하면 다음 발행이 N 을 기반으로 선언해 **자기가 방금 받은 판을 두고**
 *     「남이 올린 판이 있습니다」 동의가 뜬다(`DESIGN-server-replace.md` §2).
 *   - 옛 표식이 다른 사이트를 말하면, 표식이 링크보다 먼저이므로 폴더가 **그 사이트 소속**으로 읽힌다.
 *   - 옛 CLI 장부의 파일 목록은 「판의 진실」로 쓰여 다음 `pull` 이 엉뚱한 이유로 거절한다.
 *
 * ■ 무엇을 치우나
 *   - **받기(`"fetched"`)**: 표식을 **무조건** 지운다 — 부르는 쪽이 받은 판으로 새 표식을 쓴다. 새 표식 쓰기가
 *     실패해도 「표식 없음 → 링크가 소속」이 되어, 옛 표식이 이기는 것보다 안전한 쪽으로 떨어진다.
 *   - **zip 풀기(`"imported"`)**: **판을 주장하는** 표식(받기·발행)을 **같은 사이트의 연결 표식으로 낮춘다.**
 *     zip 은 판 번호를 모르므로 판 주장은 새 내용에 대해 거짓이 된다. 지우지 않고 낮추는 이유는 **소속을 안
 *     바꾸기** 위해서다 — 지우면 표식이 말하던 사이트가 사라져 폴더의 소속이 조용히 바뀐다(소속을 바꾸는 동사는
 *     「사이트에 연결」 하나다). 판을 주장하지 않는 연결 표식과 못 읽는 표식은 그대로 둔다(모르는 것을 안 덮는다).
 *   - CLI 장부는 둘 다 지운다.
 *
 * ⚠ **기준선에 «있던» 것만** 본다 — 해제가 방금 쓴 것은 건드리지 않는다(정본은 표식·장부를 싣지 않지만, 싣는
 *   날에도 새 내용의 것이다). 지우다 실패해도 던지지 않는다 — 받기·풀기는 이미 끝났다.
 *
 * @returns 치운 경로(보고용) — 지웠거나 연결 표식으로 낮춘 것
 */
export async function clearStaleOwnState(
    dir: string,
    before: Snapshot,
    kind: "fetched" | "imported",
): Promise<string[]> {
    const had = before.inside.get(OWN_STATE_DIR);
    if (had === undefined) return [];
    const removed: string[] = [];
    const drop = async (path: string): Promise<void> => {
        try {
            await rm(join(dir, path), { force: true });
            removed.push(path);
        } catch {
            // 이미 끝난 받기·풀기를 여기서 실패로 바꾸지 않는다
        }
    };
    if (had.has(basename(SYNC_LEDGER_PATH))) await drop(SYNC_LEDGER_PATH);
    if (had.has(basename(SOURCE_MARK_PATH))) {
        if (kind === "fetched") {
            await drop(SOURCE_MARK_PATH);
        } else {
            const text = await readFile(join(dir, SOURCE_MARK_PATH), "utf8").catch(() => null);
            const mark = parseSourceMark(text);
            const claimsRevision = mark !== null && !("origin" in mark && mark.origin === "linked");
            if (mark !== null && claimsRevision) {
                const done = await writeBindingMarkTo(dir, {
                    origin: "linked",
                    tenant: mark.tenant,
                    linkedAt: new Date().toISOString(),
                });
                if (done.ok) removed.push(SOURCE_MARK_PATH);
            }
        }
    }
    return removed;
}

/**
 * 「비어 있지 않습니다」 거절 문면의 **있는 것** 부분 — 앞 넷과 「외 n개」.
 *
 * 「비어 있지 않다」만 말하면 방금 만든 폴더를 고른 사람은 자기 눈과 도구가 다투는 것으로 읽는다(실사용
 * 신고 — 숨은 폴더 하나였다). 이름은 디스크 것이라 보여 주는 자리가 소독한다(`errorNotice`).
 */
export function occupiedLine(existing: readonly string[]): string {
    const shown = existing.slice(0, 4).join(" · ");
    const rest = existing.length - Math.min(existing.length, 4);
    return `있는 것: ${shown}${rest > 0 ? ` 외 ${rest}개` : ""}`;
}
