/**
 * **Turbopack 은 자기 몫의 `node` 를 PATH 에서 따로 찾는다.**
 *
 * ■ 왜 이 판정이 필요한가
 *   확장은 VS Code 동봉 Node(`process.execPath` + `ELECTRON_RUN_AS_NODE`)로 `next dev` 를 띄운다.
 *   그런데 Turbopack 의 CSS 경로(PostCSS)는 **네이티브 러스트 쪽에서 별도 프로세스를 띄우고**,
 *   그 프로그램 이름을 `node` 로 두고 PATH 에서 찾는다. 네이티브 바이너리 안에 그 문자열이 있다:
 *   `the PATH environment variable should always be set` · `spawning node pooled process`.
 *   Node 를 안 깐 컴퓨터에서는 그 조회가 실패하고, 첫 화면이 `500` 으로 뜬다.
 *
 * ■ 왜 「없으면 webpack」인가
 *   webpack 경로에서는 PostCSS 가 **같은 프로세스 안에서** 돌아 하위 `node` 가 필요 없다.
 *   Node 가 있는 컴퓨터에서는 Turbopack 이 더 빠르므로 그대로 둔다 — 느린 쪽으로 다 같이
 *   내리지 않는다.
 *
 * ■ 왜 `.exe` 만 보나(Windows)
 *   Turbopack 은 러스트의 `Command` 로 띄우고, 그것은 `CreateProcessW` 의 검색 규칙을 탄다 —
 *   확장자 없는 이름에는 **`.exe` 만** 붙는다. `node.cmd`·`node.bat` 이 PATH 에 있어도 그 조회는
 *   실패하므로, 여기서 그것을 「있다」로 세면 판정이 거짓이 된다.
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** 이 환경에서 `node` 라는 이름이 실행 파일로 잡히는가. */
export function hasNodeOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  if (raw.length === 0) return false;
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const at = join(dir, name);
      try {
        if (existsSync(at) && statSync(at).isFile()) return true;
      } catch {
        // 접근 불가·깨진 심링크 — 없는 것으로 본다. Turbopack 도 못 쓴다.
      }
    }
  }
  return false;
}

/**
 * `next dev` 에 붙일 추가 인자. Node 가 없으면 webpack 으로 돌린다.
 *
 * 판정을 인자 하나로 좁혀 두는 이유는, 이것이 **사용자가 보는 첫 화면을 정하는 분기**이기
 * 때문이다 — 시험이 이 함수 하나만 물면 된다.
 */
export function devEngineArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  return hasNodeOnPath(env, platform) ? [] : ["--webpack"];
}
