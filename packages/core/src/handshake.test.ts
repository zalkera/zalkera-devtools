/**
 * **핸드셰이크의 게이트와 「나가는 길」** — 0.20.1 설계자 심의가 「무그물」로 잡은 자리.
 *
 * 그 판의 명분이 *「고객 가시 변경 0」* 이었고, 그 사실이 `upgradeHow === undefined ? "" : …`
 * 한 형상에 통째로 매달려 있었다. 그런데 그 형상을 무는 시험이 **하나도 없어**, 접기를 뒤집어
 * 게이트에 걸린 전 고객 알림에 `" undefined"` 를 실어도 928건이 전부 초록이었다(심의 실측).
 */
import {ok, rejects, strictEqual} from "node:assert/strict";
import {test} from "node:test";
import {DevtoolsError} from "./errors.ts";
import {fetchHandshake} from "./handshake.ts";

/**
 * 서버 대역.
 *
 * ⚠ **봉투와 `auth` 를 실물대로 싣는다.** 이 함수는 경계에서 `body.data` 를 읽고 `auth.issuer` 가
 *   https(또는 루프백)인지 본다 — 그것을 빼면 판정에 닿기 전에 `SERVER_UNREACHABLE` 로 끝나
 *   **시험이 엉뚱한 이유로** 통과하거나 실패한다.
 */
function serverSaying(data: Record<string, unknown>): typeof fetch {
    const body = {
        data: {auth: {issuer: "https://sso.example.test/realms/z", clientId: "c", scopes: []}, ...data},
    };
    return (async () =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: {"content-type": "application/json"},
        })) as unknown as typeof fetch;
}

const REQUIRED = {verdict: "UPGRADE_REQUIRED", minExtensionVersion: "9.9.9"};

test("🔴 `upgradeHow` 를 안 주면 **아무것도 안 덧붙인다** — 「 undefined」가 고객 알림에 실리면 안 된다", async () => {
    // 0.20.1 이 「고객 가시 변경 0」일 수 있었던 유일한 이유가 이 접기다. 부르는 두 자리
    // (확장·doctor)가 이 인자를 안 넘기므로, 접기가 없으면 **전 고객**의 문면이 바뀐다.
    await rejects(
        () => fetchHandshake("https://api.example.test", "0.1.0", serverSaying(REQUIRED)),
        (e: unknown) => {
            ok(e instanceof DevtoolsError);
            strictEqual(e.code, "EXTENSION_OUTDATED");
            ok(!/undefined/.test(e.hint ?? ""), `안내에 undefined 가 실렸다: ${e.hint}`);
            ok((e.hint ?? "").startsWith("서버가 요구하는"), `안 준 방법을 자리로 남겼다: ${e.hint}`);
            return true;
        },
    );
});

test("🔴 `upgradeHow` 를 주면 **맨 앞에** 온다 — 서버 문자열이 길어도 나가는 길이 안 밀린다", async () => {
    // `humanMessage` 가 다시 300자로 죄므로, 서버가 정하는 글자가 앞에 오면 긴 값 하나로 우리
    // 안내를 통째로 밀어낼 수 있다. 그러면 「업데이트하세요」만 남고 방법이 없다.
    await rejects(
        () => fetchHandshake("https://api.example.test", "0.1.0", serverSaying(REQUIRED), "이렇게 하세요"),
        (e: unknown) => {
            ok(e instanceof DevtoolsError);
            ok((e.hint ?? "").startsWith("이렇게 하세요 "), `방법이 맨 앞이 아니다: ${e.hint}`);
            return true;
        },
    );
});

test("🔴 `UPGRADE_REQUIRED` 는 **던진다** — 통과시키면 게이트가 없는 것과 같다", async () => {
    await rejects(
        () => fetchHandshake("https://api.example.test", "0.1.0", serverSaying(REQUIRED)),
        (e: unknown) => e instanceof DevtoolsError && e.code === "EXTENSION_OUTDATED",
    );
});

test("권고·정상은 안 던진다 — 게이트는 `UPGRADE_REQUIRED` 하나다", async () => {
    for (const verdict of ["OK", "UPGRADE_RECOMMENDED", "UNKNOWN"]) {
        const h = await fetchHandshake("https://api.example.test", "0.1.0", serverSaying({verdict}));
        strictEqual(h.verdict, verdict);
    }
});
