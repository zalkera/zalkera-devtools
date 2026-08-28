/**
 * **설치가 깨졌을 때 판을 어떻게 말하는가**(설계자 심의 0.20.1 — 무그물로 잡힌 자리).
 *
 * 🔴 `"0.0.0"` 으로 접으면 그 값은 어떤 최소판에도 못 미쳐 서버가 `UPGRADE_REQUIRED` 를 내고,
 *    「업데이트한 뒤 다시 시도해 주세요」가 뜨는데 **업데이트해도 안 고쳐진다** — 낡은 것은 판이
 *    아니라 설치이기 때문이다. 두 문이 서로를 가리키는 교착이다.
 *
 * ⚠ 이 파일이 무는 것은 **판정**이다. 읽기(`version()`)는 자기 `package.json` 을 직접 열어
 *   물 자리가 없어서, 읽는 일과 판정하는 일을 갈랐다.
 */
import {ok, strictEqual, throws} from "node:assert/strict";
import {test} from "node:test";
import {DevtoolsError} from "@zalkera/devtools-core";
import {versionFrom} from "./context.ts";

test("정상 매니페스트에서는 그 판을 그대로 돌려준다", () => {
    strictEqual(versionFrom({version: "0.21.0"}), "0.21.0");
});

test("🔴 판 표기가 없으면 **던진다** — `0.0.0` 으로 접지 않는다", () => {
    for (const raw of [{}, {version: ""}, {version: "   "}, {version: 21}, {version: null}, null]) {
        throws(
            () => versionFrom(raw),
            (e: unknown) => {
                ok(e instanceof DevtoolsError, `DevtoolsError 가 아니다: ${String(e)}`);
                strictEqual(e.code, "INSTALL_BROKEN", `설치 파손이라 말하지 않았다: ${e.code}`);
                return true;
            },
            `접어서 통과시켰다: ${JSON.stringify(raw)}`,
        );
    }
});

test("🔴 나가는 길을 함께 준다 — 「깨졌습니다」만 말하면 그 자리가 막다른 길이다", () => {
    try {
        versionFrom({});
        ok(false, "던지지 않았다");
    } catch (e) {
        ok(e instanceof DevtoolsError);
        ok(/npm i -g|npx/.test(e.hint ?? ""), `다시 설치하는 방법이 없다: ${e.hint}`);
    }
});
