/**
 * **취소는 첫 컴파일 구간까지 닿아야 한다.**
 *
 * `startDevServer` 에서 제일 긴 구간은 Next 의 첫 컴파일(최대 2분)이고, 사용자가 「취소」를 누를
 * 확률이 가장 높은 자리도 거기다. 종전에는 `signal` 이 `ensureDependencies` 에만 걸려 있어서, 그
 * 구간에서 취소를 누르면 **아무 일도 일어나지 않고 서버가 그대로 섰다.**
 *
 * 취소가 무시되면 예외가 안 나므로 호출부의 catch(발급한 미리보기 키 폐기)도 안 돈다 — 세션이 서고,
 * 사이드바가 갱신되고, 브라우저 탭이 열리고, 키가 살아 있다. 「취소했는데 미리보기가 떴다」가 된다.
 *
 * 재현: `npm run test -w @zalkera/devtools-core`
 */
import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnQuietly, startDevServer, type DevServer } from "./dev.ts";
import { DevtoolsError } from "./errors.ts";
import { tempDirSync } from "./testing/tempDir.ts";

const roots: string[] = [];
const started: DevServer[] = [];
after(async () => {
  // ⚠ **치운다.** 가드를 재는 시험이 가드가 막으려는 손해(디스크·메모리 잠식)를 내면 안 된다.
  //   실제로 두 번 흘렸다 — 변이 실행이 강제 종료됐을 때, 그리고 **회귀가 났을 때**. 후자가
  //   더 나쁘다: 취소가 안 들으면 시험이 2분을 기다리다 죽고 대역이 남는데, 그때 러너는
  //   **살아 있으므로** 부모 감시가 안 뛴다. 세 겹으로 막는다.
  for (const s of started) await s.stop().catch(() => {});
  // ② 핸들이 없는 실패 경로까지 — 대역이 자기 pid 를 남긴다.
  for (const r of roots) {
    // 손자까지 본다 — 회귀가 나면 그것이 남는 자리이고, 그때가 정확히 이 그물이 필요한 때다.
    for (const name of ["band.pid", "grand.pid"]) {
      try {
        const pid = Number(readFileSync(join(r, name), "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // 안 떴거나 이미 죽었다 — 둘 다 정상이다.
      }
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * `next dev` 대역. **Ready 를 늦게 찍는다** — 그 사이가 이 시험이 재는 구간이다.
 *
 * `startDevServer` 는 `node_modules/next/dist/bin/next` 가 실재해야 진행하므로 그 좌표에 둔다.
 */
function project(readyAfterMs: number, options: { deaf?: boolean } = {}): string {
  const root = tempDirSync("zalkera-devcancel-");
  roots.push(root);
  const binDir = join(root, "node_modules", "next", "dist", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"c","private":true}');
  writeFileSync(
    join(binDir, "next"),
    `require("fs").writeFileSync(${JSON.stringify(join(root, "band.pid"))}, String(process.pid));\n` +
      // 손자 하나. Next 는 실제로 렌더 워커를 띄우고, 부모만 끊으면 그것이 고아로 남는다.
      // `deaf` 면 둘 다 SIGTERM 을 무시한다 — 그래야 5초 뒤 SIGKILL 갈래가 실제로 돈다.
      `const deaf = ${options.deaf ? "true" : "false"};\n` +
      `if (deaf) process.on("SIGTERM", () => {});\n` +
      `const g = require("child_process").spawn(process.execPath, ["-e", ` +
      `  (deaf ? "process.on('SIGTERM',()=>{});" : "") + "setInterval(()=>{},1000)"], {stdio:"ignore"});\n` +
      `require("fs").writeFileSync(${JSON.stringify(join(root, "grand.pid"))}, String(g.pid));\n` +
      `setTimeout(() => console.log("✓ Ready in ${readyAfterMs}ms"), ${readyAfterMs});\n` +
      // ③ **절대 자멸 타이머** — `unref` 하지 않는다. 부모가 살아서 매달리는 경우(회귀가 실제로
      //    만드는 형상)에는 부모 감시가 안 뛰므로, 대역이 스스로 끝나야 부모의 이벤트 루프도 풀린다.
      `setTimeout(() => process.exit(0), 20000);\n` +
      // ① 부모가 사라지면 즉시 끝낸다 — 러너가 강제 종료된 경우.
      `const ppid = process.ppid;\n` +
      `setInterval(() => { if (process.ppid !== ppid) process.exit(0); }, 500).unref();\n`,
  );
  chmodSync(join(binDir, "next"), 0o755);
  return root;
}

test("첫 컴파일을 기다리는 중에 취소하면 끊고, 서버가 서지 않는다", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  let thrown: unknown = null;
  try {
    await startDevServer({
      projectDir: project(60_000),
      nodePath: process.execPath,
      signal: controller.signal,
    });
  } catch (error) {
    thrown = error;
  }

  ok(
    thrown instanceof DevtoolsError,
    `던지지 않았다 — 취소했는데 서버가 섰다: ${String(thrown)}`,
  );
  strictEqual((thrown as DevtoolsError).code, "CANCELLED");
});

test("이미 취소된 신호를 주면 시작하지 않는다", async () => {
  const controller = new AbortController();
  controller.abort();

  let thrown: unknown = null;
  try {
    await startDevServer({
      projectDir: project(60_000),
      nodePath: process.execPath,
      signal: controller.signal,
    });
  } catch (error) {
    thrown = error;
  }
  strictEqual((thrown as DevtoolsError)?.code, "CANCELLED");
});

test("양성 통제군 — 취소하지 않으면 그대로 뜬다", async () => {
  // 「취소가 듣는다」만 재면 «아무것도 안 뜨는» 구현으로도 통과한다.
  const server = await startDevServer({
    projectDir: project(200),
    nodePath: process.execPath,
  });
  started.push(server);
  ok(server.url.startsWith("http://localhost:"), server.url);
  await server.stop();
});

test("양성 통제군 — 신호를 안 줘도 그대로 뜬다", async () => {
  const server = await startDevServer({
    projectDir: project(200),
    nodePath: process.execPath,
  });
  started.push(server);
  ok(server.port > 0);
  await server.stop();
});

/** 프로세스가 아직 살아 있는가. `kill(pid, 0)` 은 안 죽이고 존재만 묻는다. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("미리보기를 끄면 손자까지 끊는다 — 부모만 끊으면 고아가 남는다", async () => {
  // Next 는 렌더 워커를 따로 띄우고 Turbopack 은 자기 node 를 더 띄운다. 부모만 끊으면 그것들이
  // 사용자 눈에 안 보이는 채로 남아 **포트를 물고 메모리를 먹는다** — 끄는 수단도 화면에 없다.
  const root = project(200);
  const server = await startDevServer({ projectDir: root, nodePath: process.execPath });
  started.push(server);

  const grand = Number(readFileSync(join(root, "grand.pid"), "utf8").trim());
  ok(Number.isInteger(grand) && grand > 0, `손자 pid 를 못 읽었다: ${grand}`);
  ok(alive(grand), "손자가 안 떴다 — 이 시험이 아무것도 안 재고 있다");

  await server.stop();
  // 신호가 닿고 프로세스가 사라지기까지 잠깐 걸린다.
  for (let i = 0; i < 40 && alive(grand); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(!alive(grand), `손자가 살아남았다(pid ${grand}) — 미리보기를 껐는데 프로세스가 남는다`);
});

test("SIGTERM 을 안 듣는 트리도 5초 뒤 끊는다", async () => {
  // 부드럽게 끊는 갈래만 시험하면 **강제 갈래는 아무도 안 본다.** 실측으로 그 갈래를 트리가
  // 아니라 당사자로 바꿔도 전건 초록이었다 — SIGTERM 이 먼저 다 끝내 버렸기 때문이다.
  const root = project(200, { deaf: true });
  const server = await startDevServer({ projectDir: root, nodePath: process.execPath });
  started.push(server);

  const grand = Number(readFileSync(join(root, "grand.pid"), "utf8").trim());
  ok(alive(grand), "손자가 안 떴다");

  await server.stop();
  for (let i = 0; i < 40 && alive(grand); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(!alive(grand), `SIGTERM 을 무시하는 손자가 살아남았다(pid ${grand})`);
});

test("없는 명령을 띄워도 프로세스가 죽지 않는다", async () => {
  // ⚠ `spawn` 의 ENOENT 는 **던지지 않는다** — `error` 이벤트로 온다. `try/catch` 만 두면 그
  //    명령이 없는 기계에서 처리되지 않은 `error` 가 되어 확장이 통째로 죽는다(심의 차단).
  //    이 자리는 윈도의 `taskkill` 폴백인데, 그 갈래는 이 박스에서 재지 못한다 — 기전만 문다.
  spawnQuietly("zalkera-이-명령은-없다", ["--x"]);
  // 이벤트 루프가 한 바퀴 돌아야 `error` 가 도착한다. 처리되지 않았다면 여기서 죽는다.
  await new Promise((r) => setTimeout(r, 200));
  ok(true, "여기까지 왔으면 살아 있다");
});

test("있는 명령은 그대로 띄운다 — 「무엇이든 삼킨다」가 아니다", async () => {
  const marker = join(tempDirSync("zalkera-spawnq-"), "ran");
  spawnQuietly(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`]);
  for (let i = 0; i < 40 && !existsSync(marker); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(existsSync(marker), "명령이 안 돌았다 — 이 함수가 아무것도 안 띄우고 있다");
});
