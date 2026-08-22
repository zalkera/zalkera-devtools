/**
 * **폴더 내용을 통째로 갈아 끼운다 — 실패하면 되돌린다.**
 *
 * 대행사가 새 zip 을 보내오는 것은 예외가 아니라 정상 흐름이다. 그런데 `zip 으로 시작`은
 * **빈 폴더만** 받으므로, 갱신하려면 사람이 손으로 폴더를 비워야 했다. 그 조작에는 함정이 둘이다.
 *
 *   ⑴ `rm -rf 폴더/*` 는 **dot 파일을 하나도 못 지운다**(`.gitignore`·`.github/`·`.zalkera/` …).
 *      남은 것 때문에 「비어 있지 않습니다」로 막히는데, 원인이 눈에 안 보인다.
 *   ⑵ 되돌릴 수 없다. 중간에 실패하면 옛 소스도 새 소스도 없는 자리에 사람이 남는다.
 *
 * 그래서 **옆에 치워 두고 채운 뒤, 성공했을 때만 버린다.** 실패하면 치운 것을 그대로 되돌린다.
 *
 * ⚠ **치우는 자리는 형제 디렉터리다.** `tmpdir()` 로 옮기면 파일시스템이 달라 `rename` 이
 *   `EXDEV` 로 죽는다 — 그때 「되돌린다」는 약속이 거짓이 된다.
 * ⚠ **보존 파일은 옮기기 «전»에 메모리로 읽는다.** 옮긴 뒤에 읽으려 하면 그 경로가 이미 없다.
 */
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/** 갈아 끼운 결과. `preserved` 는 새 소스 위에 되살린 경로다. */
export interface ReplaceResult {
  preserved: string[];
}

async function moveAll(from: string, to: string): Promise<void> {
  for (const name of await readdir(from)) {
    await rename(join(from, name), join(to, name));
  }
}

/**
 * `dir` 의 내용을 비우고 `fill()` 로 다시 채운다.
 *
 * @param dir      갈아 끼울 폴더. 존재해야 한다.
 * @param preserve `dir` 기준 상대 경로. 있으면 새 내용 «위에» 되살린다(없으면 조용히 건너뛴다).
 * @param fill     빈 `dir` 을 채우는 일. 던지면 전부 되돌린다.
 */
export async function replaceContents(
  dir: string,
  preserve: readonly string[],
  fill: () => Promise<void>,
): Promise<ReplaceResult> {
  // ⑴ 보존 대상을 먼저 읽는다 — 옮긴 뒤에는 그 경로가 없다.
  const kept = new Map<string, Buffer>();
  for (const rel of preserve) {
    try {
      kept.set(rel, await readFile(join(dir, rel)));
    } catch {
      /* 없으면 보존할 것도 없다 */
    }
  }

  // ⑵ 형제 자리로 치운다. 같은 파일시스템이라 `rename` 이 산다.
  const stash = await mkdtemp(join(dirname(dir), ".zalkera-stash-"));
  await moveAll(dir, stash);

  try {
    await fill();
  } catch (cause) {
    // ⑶ 채우다 실패 — 새로 쓴 것을 걷고 옛것을 되돌린다.
    for (const name of await readdir(dir))
      await rm(join(dir, name), { recursive: true, force: true });
    await moveAll(stash, dir);
    await rm(stash, { recursive: true, force: true });
    throw cause;
  }

  // ⑷ 성공. 보존 파일을 새 소스 위에 얹고 치운 것을 버린다.
  const preserved: string[] = [];
  for (const [rel, bytes] of kept) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), bytes);
    preserved.push(rel);
  }
  await rm(stash, { recursive: true, force: true });
  return { preserved };
}
