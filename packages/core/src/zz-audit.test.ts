import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {pushSiteSource} from "./push.ts";
import {SYNC_LEDGER_FORMAT, SYNC_LEDGER_PATH, serializeSyncLedger, type SyncLedger} from "./syncLedger.ts";
import {tempDir} from "./testing/tempDir.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 실제 드래프트를 들고 있는 서버 대역 — 올린 것이 다음 조회에 보인다. */
function liveServer() {
    const changed = new Map<string, string>();
    const deleted = new Set<string>();
    let gen = 0;
    return {
        changed,
        api: {
            tenantCode: () => "acme",
            listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
            draftFiles: async () => ({
                generation: gen === 0 ? null : `G${gen}`,
                changed: [...changed].map(([path, sha256]) => ({path, sha256})),
                deleted: [...deleted],
                baseRevisionNo: gen === 0 ? null : 7,
                strandedOnOldRevision: false,
            }),
            editDraft: async (edits: Array<{path: string; content?: string; remove?: boolean}>) => {
                for (const e of edits) {
                    if (e.remove) { changed.delete(e.path); deleted.add(e.path); }
                    else { deleted.delete(e.path); changed.set(e.path, sha(e.content ?? "")); }
                }
                gen += 1;
                return {generation: `G${gen}`, files: [], warning: null, previewUrl: null};
            },
        } as never,
    };
}

test("AUDIT — 같은 파일을 고쳐 두 번 올린다", async () => {
    const s = liveServer();
    const dir = await tempDir("zalkera-audit-");
    await writeFile(join(dir, "a.tsx"), "첫 고침");
    const ledger: SyncLedger = {
        format: SYNC_LEDGER_FORMAT,
        tenant: "acme",
        base: {revisionNo: 7, tarSha256: "a".repeat(64)},
        files: {"a.tsx": {sha256: sha("판 원본"), bytes: 3}},
        server: null,
        mine: {},
        pulledAt: "2026-08-01T00:00:00.000Z",
        pushedAt: null,
    };
    await mkdir(join(dir, ".zalkera"), {recursive: true});
    await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(ledger));

    const first = await pushSiteSource({api: s.api, folder: dir});
    console.log("① 1회차:", JSON.stringify({sent: first.sent, generation: first.generation}));

    // 같은 파일을 **내가** 다시 고친다 — 남은 아무것도 안 했다.
    await writeFile(join(dir, "a.tsx"), "둘째 고침");
    try {
        const second = await pushSiteSource({api: s.api, folder: dir});
        console.log("② 2회차 성공:", JSON.stringify({sent: second.sent}));
    } catch (error) {
        console.log("② 2회차 **거절**:", (error as Error & {code?: string}).code, "\n---\n" + (error as Error).message + "\n---");
    }

    // 3회차: 안 고치고 그대로 다시 올려 본다
    try {
        const third = await pushSiteSource({api: s.api, folder: dir});
        console.log("③ 안 고치고 다시:", JSON.stringify({sent: third.sent}));
    } catch (error) {
        console.log("③ 안 고치고 다시 **거절**:", (error as Error & {code?: string}).code);
    }
});
