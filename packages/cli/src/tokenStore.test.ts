import {ok, strictEqual} from "node:assert/strict";
import {stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {FileTokenStore, tokenPath} from "./tokenStore.ts";
import {tempDir} from "../../core/src/testing/tempDir.ts";

const tokens = {accessToken: "a", refreshToken: "r", expiresAt: 1, issuer: "https://id.example"};

test("🔴 토큰은 **홈 아래**에 둔다 — 소스 폴더는 zip 으로 유통되는 경로다", () => {
    strictEqual(tokenPath({}, "/home/u"), "/home/u/.config/zalkera/auth.json");
    strictEqual(tokenPath({XDG_CONFIG_HOME: "/home/u/cfg"}, "/home/u"), "/home/u/cfg/zalkera/auth.json");
});

test("🔴 상대 `XDG_CONFIG_HOME` 은 무시한다 — 작업 폴더(=소스 폴더)에 토큰이 떨어진다", () => {
    strictEqual(tokenPath({XDG_CONFIG_HOME: "cfg"}, "/home/u"), "/home/u/.config/zalkera/auth.json");
    strictEqual(tokenPath({XDG_CONFIG_HOME: "../위로"}, "/home/u"), "/home/u/.config/zalkera/auth.json");
    strictEqual(tokenPath({XDG_CONFIG_HOME: ""}, "/home/u"), "/home/u/.config/zalkera/auth.json");
});

test("🔴 **절대경로여도 홈 밖이면** 무시한다 — `XDG_CONFIG_HOME=$PWD/.config` 는 CI 의 실재 관례다", () => {
    // 그 값을 그대로 쓰면 refresh 토큰이 소스 폴더 안에 떨어지고, 그 폴더는 zip 으로 유통된다.
    // 「내 사이트 소스 보내 주세요」 한 번에 발행 권한이 넘어간다.
    for (const outside of ["/srv/사이트/.config", "/tmp/cfg", "/home/다른사람/.config", "/home/u2/.config"]) {
        strictEqual(
            tokenPath({XDG_CONFIG_HOME: outside}, "/home/u"),
            "/home/u/.config/zalkera/auth.json",
            `${outside} 를 그대로 썼다`,
        );
    }
});

test("홈 아래 절대경로는 존중한다 — 규율이 아니라 감옥이 되면 안 된다", () => {
    strictEqual(tokenPath({XDG_CONFIG_HOME: "/home/u/cfg"}, "/home/u"), "/home/u/cfg/zalkera/auth.json");
    strictEqual(tokenPath({XDG_CONFIG_HOME: "/home/u"}, "/home/u"), "/home/u/zalkera/auth.json");
});

test("🔴 파일 권한이 0600 이다", async () => {
    const dir = await tempDir("zalkera-token-");
    const path = join(dir, "깊이", "auth.json");
    const store = new FileTokenStore(path);
    await store.write(tokens);
    strictEqual((await stat(path)).mode & 0o777, 0o600);
    strictEqual((await stat(join(dir, "깊이")).then((s) => s.mode & 0o777)), 0o700);
});

test("🔴 이미 있던 헐거운 파일도 0600 으로 죈다", async () => {
    const dir = await tempDir("zalkera-token-loose-");
    const path = join(dir, "auth.json");
    await writeFile(path, "{}", {mode: 0o644});
    await new FileTokenStore(path).write(tokens);
    strictEqual((await stat(path)).mode & 0o777, 0o600, "이미 있던 파일의 권한이 그대로 남았다");
});

test("쓰고 읽으면 같다 · 지우면 없다", async () => {
    const path = join(await tempDir("zalkera-token-rt-"), "auth.json");
    const store = new FileTokenStore(path);
    strictEqual(await store.read(), null);
    await store.write(tokens);
    ok(await store.read());
    strictEqual((await store.read())?.refreshToken, "r");
    await store.clear();
    strictEqual(await store.read(), null);
    await store.clear();
});

test("🔴 반쯤 읽지 않는다 — 모자란 토큰은 401 을 「권한 없음」으로 보이게 한다", async () => {
    const dir = await tempDir("zalkera-token-bad-");
    for (const [name, body] of [
        ["깨짐.json", "{"],
        ["부분.json", JSON.stringify({accessToken: "a"})],
        ["형틀림.json", JSON.stringify({...tokens, expiresAt: "1"})],
        ["배열.json", "[]"],
        ["널.json", "null"],
    ] as const) {
        const path = join(dir, name);
        await writeFile(path, body);
        strictEqual(await new FileTokenStore(path).read(), null, `${name} 을 읽었다`);
    }
});
