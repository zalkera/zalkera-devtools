#!/usr/bin/env node
/**
 * **배선 검사 — 판정을 부르는 자리가 살아 있는가.**
 *
 * ■ 왜 생겼나
 *   이 레포는 판정을 core 로 내려 시험이 물게 해 왔다. 그런데 심의가 변이 21건을 걸어 보니
 *   **9건이 전건 초록으로 살아남았고, 전부 「판정을 부르는 배선」**이었다. `devEngineArgs()` 자체는
 *   시험이 무는데 그것을 `spawn` 인자에 넘기는 한 줄은 아무도 안 물었다 — 그 줄만 지우면 Node
 *   없는 컴퓨터 전원이 첫 화면 500 으로 돌아가는데 시험 전건이 초록이었다.
 *
 * ■ **존재가 아니라 횟수를 센다**
 *   같은 조각이 두 자리에 있으면 「있는가」는 하나만 남아도 참이다. 실측으로 그 형상이 있었다 —
 *   `if (previewGuard.busy)` 가 두 곳(로그아웃 거절·미리보기 재진입)에 있어서, 로그아웃 쪽을
 *   무력화해도 이 검사기가 초록이었다. 그래서 목록의 넷째 칸이 **기대 횟수**다(생략하면 1).
 *
 * ■ **래퍼 안쪽도 목록에 적는다**
 *   등록부(`register(..., () => withReceiveGuard(f))`)만 고정하면 그 래퍼의 본문을 비워도 안 걸린다.
 *   가드가 실제로 서는 줄을 따로 적는다.
 *
 * ■ 왜 AST 가 아니라 문면인가
 *   여기서 재는 것은 **한 줄이 있는가**다. 형태가 바뀌면 이 검사기가 「못 찾았다」로 서야 하고,
 *   그때 사람이 와서 배선이 여전한지 보는 것이 맞다. 조용히 통과하는 쪽이 훨씬 나쁘다.
 *   (`check-upgrade-notice.mjs` 가 같은 규율을 쓴다.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** [파일, 있어야 하는 조각, 사라지면 무슨 일이 나는가] */
const WIRES = [
    [
        "packages/vscode/src/extension.ts",
        "folderTenant: currentFolderBinding()",
        "게이트와 사이드바가 서로 다른 기준으로 소속을 판정해, 화면은 건강한데 누르면 막힌다",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "const scope = decideTenantScope({",
        "사이트 선택이 다시 남의 폴더 링크를 덮는다 — 이 판을 만든 그 결함이 되살아난다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'register("zalkera.site.useFolder", useFolderSite)',
        "어긋난 폴더의 복귀 버튼이 아무 명령도 못 부르고, 그 폴더가 갇힌다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'origin: "published"',
        "발행이 소속을 결정화하지 않아, 표식 없는 폴더가 영원히 게이트 밖에 남는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'origin: "linked"',
        "재연결이 표식을 안 남겨 링크와 표식이 갈리고, 「어긋남은 사고다」가 성립하지 않는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await withReceiveGuard(() => openSite(captureTenant(picked)))",
        "제안 흐름의 받기가 겹쳐 돌거나, 라이브 사이트를 읽어 엉뚱한 사이트의 소스를 내려받는다",
    ],
    [
        "packages/core/src/dev.ts",
        "...engineArgs",
        "Node 없는 컴퓨터에서 미리보기 첫 화면이 500 으로 돌아간다(Turbopack 이 PATH 에서 node 를 못 찾는다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        'register("zalkera.site.open", () => withReceiveGuard(openSite))',
        "소스 받기가 겹쳐 돌아 두 꾸러미가 같은 폴더에 섞이고, 한쪽 롤백이 다른 쪽 파일을 지운다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'register("zalkera.site.create", () => withReceiveGuard(startFromExample))',
        "위와 같다 — 예제로 시작도 같은 폴더에 푼다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await previewGuard.run(() => startPreviewGuarded(pinned))",
        "미리보기 시작이 두 번 눌리면 키가 2회 발급돼 두 번째가 첫 번째를 폐기하고, dev 서버 2개가 뜨며 첫 서버는 UI 에서 끌 수 없는 고아가 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (previewGuard.busy)",
        "⑴ 준비 중 로그아웃이 통과해 사이드바는 로그아웃 화면인데 상태바는 미리보기가 도는 상태로 어긋난다 " +
            "⑵ 미리보기 시작이 겹친다. **두 자리 다** 필요하다 — 하나만 세면 다른 하나를 지워도 안 걸린다",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!choice) throw noRevisionError(revisions);",
        "한 번도 안 올린 사람에게 「빌드 중이거나 실패했습니다」라고 말하고 빈 「버전 이력」으로 보낸다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!needsDiscardConsent(error)) throw error;",
        "서버가 「계속하려면 확인해 주세요」라고 말한 거절에 확인할 자리가 없어져, 버전 전환이 막다른 길이 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await activate(true);",
        "동의를 받아 놓고 서버에는 전하지 않는다 — 같은 거절이 반복된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "plainNotice(r.label, 80)",
        "버전에 붙인 이름이 「버전 이력」에서 사라진다(백엔드 필드는 `label` 이다 — `note` 로 적으면 늘 undefined 라 조용히 안 보인다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await revokeRecordedKeys();",
        "로그아웃·초기화가 다른 창이 켠 미리보기 열쇠를 안 지워, 그 열쇠가 최대 12시간 상용 데이터를 계속 읽는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!(await signOut({ quiet: true }))) return;",
        "미리보기 준비 중 초기화가 그대로 진행돼, 로그인은 살아 있고 미리보기는 뒤늦게 뜨는데 사이트 설정만 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'if (notice.kind === "cancelled") return;',
        "사용자가 스스로 그만둔 일이 빨간 오류 창으로 뜬다 — 로그인 창을 닫았을 뿐인데 「인터넷을 확인하세요」를 본다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const doomed = mine ? addIssuedKey(recordedKeys(), mine) : recordedKeys();",
        "발급 직후 로그아웃하면 그 열쇠가 저장 목록에 아직 없어, 아무도 못 지운 채 최대 12시간 산다",
    ],
    [
        "packages/core/src/dev.ts",
        'child.on("error", () => {',
        "taskkill 이 없는 윈도 기계에서 처리되지 않은 error 이벤트가 되어 확장이 통째로 죽는다(spawn 의 ENOENT 는 던지지 않는다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if ((await receiveGuard.run(run)) === BUSY)",
        "등록부는 `withReceiveGuard` 를 부르는데 그 **본문**이 가드를 안 지나면 소스 받기가 겹친다 — " +
            "등록줄만 보는 검사는 래퍼 속을 못 본다(심의 실증: 본문을 `await run()` 으로 갈아도 초록이었다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        'if (notice.kind !== "cancelled") {',
        "12시간 자동 갱신 중에 스스로 취소를 누른 사람에게 「갱신하지 못해 미리보기가 멈췄습니다」 빨간창이 뜬다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "plainNotice(r.label, 60)",
        "버전에 붙인 이름이 **고를 때** 안 보인다 — 이력에만 있으면 정작 고르는 자리에서 번호만 보고 고른다(CHANGELOG 가 둘 다 약속한다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "reapDropped(",
        "목록 상한을 넘어 밀려난 미리보기 열쇠를 아무도 안 지워, 도움말의 「로그아웃하면 폐기됩니다」가 그 자리에서 거짓이 된다",
        3,
    ],
    [
        "packages/vscode/src/extension.ts",
        "onConsent: (serverMessage) => askDiscardConsent(tenant, serverMessage),",
        "새 버전 올리기가 zip 을 다 올린 뒤 409 를 받고 「계속하려면 확인해 주세요」만 반복한다 — 확인할 자리가 없는 막다른 길이 된다",
    ],
    [
        "packages/core/src/publish.ts",
        "return await options.api.confirmArchive(storageKey, true);",
        "동의를 받아 놓고 서버에는 전하지 않는다 — 같은 409 가 반복된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "return answer === ask.action;",
        "동의 창은 뜨는데 **무엇을 누르든 동의**가 된다 — 게시 대기 중인 AI 변경이 사람이 거절해도 사라진다. " +
            "올리기·전환 두 문이 이 한 점을 공유하므로 파급이 둘이다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!(await askDiscardConsent(tenant, (error as Error).message))) return;",
        "전환에서 거절해도 그대로 진행한다 — 사람이 「아니오」를 눌렀는데 AI 변경이 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "void revokeKeyQuietly(key.keyId, key.tenant);",
        "목록 상한에 밀려난 열쇠를 서버에서 안 지운다 — 그 열쇠가 최대 12시간 산다",
    ],
    [
        "packages/core/src/untar.ts",
        "await writeExclusive(path, data, name, written);",
        "tar 쪽에서 「원래 있던 파일」과 「아카이브 중복 항목」이 다시 뭉친다 — 후자에 「빈 폴더를 만드세요」는 무한 고리다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (await announceIfBlocked(command)) return;",
        "사이드바가 여섯 묶음을 항상 보여 주는데 요건이 안 맞는 것을 눌러도 아무 말이 없다 — 「눌러도 아무 일이 없다」에 갇힌다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "vscode.ConfigurationTarget.Workspace,",
        "고른 사이트를 한 범위만 지우면 남은 쪽이 되살아난다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "site: siteDir(),",
        "사이드바와 요건 게이트가 서로 다른 기준으로 「소스가 있나」를 판정한다 — 화면은 없다는데 게이트는 통과시킨다",
        2,
    ],
    [
        "packages/core/src/fetchSource.ts",
        "if (!choice) throw noRevisionError(revisions);",
        "공개 API 로 판을 안 주고 부르면 BUILDING·FAILED 판을 받으러 가고, 「없다」 문면도 옛 사본이 나온다",
    ],
    [
        "packages/core/src/fetchSource.ts",
        "rejectVendored: true",
        "받은 소스가 `node_modules` 를 담고 있어도 그대로 풀린다",
    ],
];

/**
 * **있으면 안 되는 것.** 배선의 반대편이다 — 공용 문을 만들어 놓고 그 문을 **비켜 가는 길**이
 * 열려 있으면, 다음에 생기는 자리가 조용히 그리로 간다(이 레포가 임시 폴더에서 실제로 겪었다:
 * 시험 17개 파일 중 회수까지 하는 것은 여섯이었다).
 *
 * [파일 glob, 있으면 안 되는 조각, 대신 무엇을 쓰나]
 */
const BANS = [
    [
        "packages/vscode/src/*.ts",
        /new Date\(r\.createdAt\)/,
        "core 의 `revisionWhen(r.createdAt)` — 백엔드가 `Instant?` 로 보내므로 널이면 1970-01-01 이 조용히 그려진다",
    ],
    [
        "packages/vscode/src/*.ts",
        /code === "CANCELLED"/,
        "core 의 `isCancelled(error)` — 취소 판정을 확장 안에 사본으로 두면 그 자리만 낡는다" +
            "(실측: 확장에 사본이 셋 있었고, 갱신 타이머의 것은 스스로 취소한 사람에게 빨간창을 띄웠다)",
    ],
    [
        "packages/core/src/*.test.ts",
        /\bmkdtemp(?:Sync)?\s*\(/,
        "`testing/tempDir.ts` 의 `tempDir()`·`tempDirSync()` — 만든 것을 자동으로 회수한다",
    ],
    [
        "packages/core/src/*.test.ts",
        /\btmpdir\s*\(\s*\)/,
        "`tempDir()` — `tmpdir()` 바로 아래에 쓴 것은 회수 대상이 아니다",
    ],
];

/**
 * **계정에 딸린 자리는 목록에서 유도한다.** 손으로 옮겨 적으면 목록과 배선이 갈리고, 그러면
 * 목록이 「지운다」고 적어 둔 것을 아무도 안 지운다.
 *
 * `accountState.ts` 가 자리마다 집행 조각을 들고 있으므로, 여기서는 그것이 확장에 실재하는지만 본다.
 * 목록에 자리를 더하면 배선도 같이 요구된다 — 그것이 이 유도의 요점이다.
 */
function accountWires() {
    const src = read("packages/core/src/accountState.ts");
    const body = src.slice(src.indexOf("export const ACCOUNT_SCOPED"), src.indexOf("export type AccountScoped"));

    // ⚠ **항목 블록으로 자른 뒤 필드를 따로 읽는다.** 한 정규식으로 세 필드를 이어 읽으면
    //    lazy 매칭이 **항목 경계를 넘어** 두 항목을 하나로 삼킨다 — 필드 순서만 바꿔도 그렇게 된다
    //    (심의 실증: `{what, enforcedBy, why}` 로 뒤집자 유도가 4→3 이 되고, 하필 빠진 것이
    //    `clearTenantSetting()` 이라 그 호출을 지워도 전 검사가 초록이었다).
    const blocks = body.split(/\n\s*\{/).slice(1);
    const field = (block, name) => {
        // 문자열 리터럴 하나를 통째로 — 이스케이프된 따옴표를 포함한다.
        const m = new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
        return m ? m[1] : null;
    };
    const out = [];
    for (const block of blocks) {
        const what = field(block, "what");
        const why = field(block, "why");
        const enforcedBy = field(block, "enforcedBy");
        if (what === null && why === null && enforcedBy === null) continue; // 항목이 아닌 조각
        if (what === null || why === null || enforcedBy === null) {
            console.error(`✗ 계정 자리 항목에 빠진 필드가 있습니다(통과가 아닙니다): ${block.slice(0, 60).trim()}…`);
            process.exit(2);
        }
        // 목록은 JS 문자열이라 `\"` 로 이스케이프돼 있다 — 실제 소스에서 찾을 형태로 되돌린다.
        out.push(["packages/vscode/src/extension.ts", enforcedBy.replace(/\\"/g, '"'), `로그아웃이 ${what} 를 안 지운다 — ${why}`]);
    }

    // ⚠ **부분 판독을 무경보로 넘기지 않는다.** `out.length === 0` 만 보면 **일부만** 읽힌 경우가
    //    조용히 지나가고, 그때 잃은 자리는 아무도 안 지킨다. 목록이 스스로 선언한 개수와 맞춘다.
    const declared = (body.match(/\bwhat:\s*"/g) ?? []).length;
    if (declared === 0 || out.length !== declared) {
        console.error(
            `✗ 계정 자리 유도가 ${out.length}건인데 목록은 ${declared}건입니다(통과가 아닙니다) — ` +
                "accountState.ts 의 형태를 확인하십시오.",
        );
        process.exit(2);
    }
    return out;
}

WIRES.push(...accountWires());

const problems = [];
for (const [pattern, shape, instead] of BANS) {
    const dir = join(root, dirname(pattern));
    const suffix = basename(pattern).replace(/^\*/, "");
    const files = readdirSync(dir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) {
        console.error(`✗ 금지 검사 — ${pattern} 에 해당하는 파일이 0개입니다(통과가 아닙니다).`);
        process.exit(2);
    }
    for (const file of files) {
        const rel = `${dirname(pattern)}/${file}`;
        if (shape.test(read(rel))) {
            problems.push(`${rel}: 비켜 가는 길이 열렸다 — ${shape}\n    → 대신 ${instead}`);
        }
    }
}
/** 겹치지 않는 등장 횟수. `includes` 는 **하나만 있으면 참**이라 나머지를 못 지킨다. */
function countOccurrences(haystack, needle) {
    let n = 0;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n += 1;
    return n;
}

for (const [file, needle, why, times = 1] of WIRES) {
    // ⚠ **존재가 아니라 횟수를 센다.** 같은 조각이 두 자리에 있으면 `includes` 는 **하나를 지워도**
    //    참이다 — 심의 실증: `if (previewGuard.busy)` 가 signOut·미리보기시작 두 곳에 있어, 로그아웃
    //    쪽을 `if (false)` 로 바꿔도 이 검사기가 초록이었다. 그 자리는 배송 문서가
    //    「준비하는 동안에는 로그아웃과 초기화가 잠시 거절됩니다」라고 약속한 바로 그 자리다.
    //
    //    많아지는 것도 반려다. 같은 판정이 두 벌이 되면 한쪽만 고쳐진다 — 이 레포가 반복해서 겪은 병이다.
    const got = countOccurrences(read(file), needle);
    if (got === times) continue;
    problems.push(
        got === 0
            ? `${file}: 배선이 없다 — ${needle}\n    → ${why}`
            : `${file}: 배선이 ${got}자리다(기대 ${times}) — ${needle}\n    → ${why}`,
    );
}

if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error("");
    console.error("  형태를 바꾸셨다면 이 검사기의 목록도 같이 고치십시오 — 조용히 통과하는 쪽이 훨씬 나쁩니다.");
    process.exit(1);
}
console.log(`✓ 배선 검사 — ${WIRES.length}자리가 제자리에 있고 금지 ${BANS.length}종이 안 쓰였다(계정 자리 ${accountWires().length}은 목록에서 유도)`);
