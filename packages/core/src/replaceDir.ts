/**
 * **폴더 내용을 새 소스로 갈아 끼운다 — 실패하면 되돌리고, 못 싣는 것은 안 건드린다.**
 *
 * 대행사가 새 zip 을 보내오는 것은 예외가 아니라 정상 흐름인데, `zip 으로 시작`은 **빈 폴더만**
 * 받으므로 갱신하려면 사람이 손으로 폴더를 비워야 했다. 그 조작에는 함정이 둘이다.
 *
 *   ⑴ `rm -rf 폴더/*` 는 **dot 파일을 하나도 못 지운다**(`.gitignore`·`.github/` …). 남은 것 때문에
 *      「비어 있지 않습니다」로 막히는데, 원인이 눈에 안 보인다.
 *   ⑵ 되돌릴 수 없다. 중간에 실패하면 옛 소스도 새 소스도 없는 자리에 사람이 남는다.
 *
 * 그래서 **옆에 치워 두고 채운 뒤 성공했을 때만 버린다.** 실패하면 치운 것을 그대로 되돌린다.
 *
 * ## 안 건드리는 것 — `keep`
 *
 * ⚠ **zip 이 실어 올 수 없는 것을 지우면 이 명령이 「원래 문제」보다 나빠진다**(심의 실측).
 *   포장기가 `.git`·`.env*`·`.vscode`·`.mcp.json`·`node_modules` 를 **일부러 뺀다** — 자격증명이
 *   딸려 가지 않게 하려는 것이다. 그러니 새 zip 에는 그것들이 없고, 그냥 갈아 끼우면 **고객의
 *   이력·시크릿·에디터 설정이 영구히 사라진다.** 손으로 비우던 방식은 그것들을 **안 지웠다**
 *   (dot 파일이라서). 대체하는 쪽이 더 많이 지우면 안 된다.
 *
 *   `keep` 은 **치우지도 않는다** — 자리에 그대로 둔다. 옮겼다 되돌리는 길은 실패 지점이 하나 더
 *   늘 뿐이다.
 *
 * ## 되돌리기가 실제로 도는 자리
 *
 * ⚠ **치우는 일 자체를 `try` 안에 둔다.** 밖에 두면 `rename` 이 중간에 실패했을 때 예외가 `try` 를
 *   안 지나 **되돌리기가 아예 안 돈다** — 폴더가 반쯤 빈 채로 남고 나머지는 탐색기에 안 보이는
 *   점(.) 형제 폴더에 갇힌다(심의 실측: 20개 중 4번째에서 EACCES).
 * ⚠ **치우는 자리는 형제 디렉터리다.** `tmpdir()` 로 옮기면 파일시스템이 달라 `rename` 이 `EXDEV`
 *   로 죽어 「되돌린다」가 거짓이 된다. 심링크로 열린 폴더는 `dirname` 이 링크의 부모라 같은 일이
 *   나므로 **실경로로 편 뒤** 형제를 잡는다.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isExcludedEntry } from "./zip.ts";

/**
 * **다시 만들어지는 것** — 손 목록에서 뺀다.
 *
 * 포장기가 이것들을 제외하는 이유는 자격증명이 아니라 **크기**다. 새 소스가 자기 것으로 다시
 * 만드므로 남기면 오히려 해롭다 — 특히 `node_modules` 는 의존 캐시가 «있는 트리 위에» 하드링크로
 * 겹쳐지면서 겹치는 경로의 **옛 바이트가 그대로 남는다**(`deps.ts` 의 `hardlinkTree`). 새 소스가
 * 옛 의존을 조용히 쓰는 상태가 되고, 미리보기가 원인 없이 깨진다(확인 심의 실측).
 */
const REGENERABLE = new Set(["node_modules", ".next", "dist", "out", ".turbo", ".vercel", "__macosx", ".ds_store"]);

/**
 * 갈아 끼우는 동안 원래 소스를 치워 두는 폴더의 **이름 접두**.
 *
 * ⚠ **만드는 자리와 찾는 자리가 이 상수 하나를 쓴다.** 값을 옮겨 적으면 접두를 바꾼 날 감지기가
 *   **영원히 조용히 빈손**이 된다(fail-open) — 잔재는 그대로 남는데 아무도 말하지 않는 상태다.
 *   이 레포는 손으로 복제한 목록이 갈리는 사고를 되풀이해 겪었다.
 */
export const STASH_PREFIX = ".zalkera-stash-";

/**
 * 소스 폴더의 **형제들** 중 지난 갈아 끼우기가 남긴 것.
 *
 * ■ 왜 남나
 *   [replaceContents] 는 던진 예외에서 되돌리고, 되돌리기까지 실패하면 이 폴더의 자리를 말한다.
 *   그런데 **프로세스가 즉사하면**(창 닫기·전원·강제 종료) 그 둘 다 안 돈다 — 원래 소스가 여기
 *   남은 채, 그 사실을 아는 사람이 아무도 없다.
 *
 * ⚠ **찾기만 한다 — 지우지 않는다.** 이 폴더는 **원본의 유일한 사본일 수 있다**(중단 시점에 따라
 *   소스 폴더 쪽이 반쪽이다). 지우는 것은 제스처가 있어도 새 파괴면이고, 되돌리는 것은 그 자체가
 *   또 한 번의 갈아 끼우기(같은 기계·같은 실패면)다. 사람이 탐색기에서 한다.
 *
 * 순수 함수다 — 부르는 쪽이 `readdir` 한 이름을 넘긴다(활성화 구간에 I/O 를 더하지 않는다).
 */
export function stashLeftovers(entryNames: readonly string[]): string[] {
    return entryNames.filter((n) => n.startsWith(STASH_PREFIX)).sort();
}

/**
 * 갱신이 **안 건드릴** 이름들. `dir` 바로 아래에서 고른다.
 *
 * ⚠ **손으로 열거하지 마라.** 포장기가 zip 에서 빼는 것과 여기 남기는 것이 **같은 술어**여야
 *   두 목록이 갈리지 않는다. 손 목록은 실제로 갈렸다 — `.ssh`·`.aws`·`.idea`·`.npmrc`·
 *   `.env.production`·`*.pem` 이 빠져 그대로 지워지고 있었다(확인 심의 실측). 대소문자와
 *   앞으로 늘어날 이름까지 이 한 줄이 따라간다.
 *
 * **한계 정직**: `dir` **바로 아래**만 본다. 하위 폴더의 `apps/web/.env.local` 같은 것은 못 지킨다 —
 * 깊이까지 가려면 트리를 걸어 부분 이동을 해야 하고, 그 실패면이 이 함수가 막으려는 바로 그
 * 사고다. 단일 앱 소스가 계약이라 그 형상이 드문 것에 기대는 선택이다.
 */
export async function keepNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => isExcludedEntry(n) && !REGENERABLE.has(n.toLowerCase()));
}

/** 갈아 끼운 결과. */
export interface ReplaceResult {
  /** 새 소스 위에 되살린 경로. */
  preserved: string[];
  /** 자리에 그대로 둔 이름(치우지도 지우지도 않았다). */
  kept: string[];
}

async function moveAll(
  from: string,
  to: string,
  skip: ReadonlySet<string> = new Set(),
  moved?: Set<string>,
): Promise<void> {
  for (const name of await readdir(from)) {
    if (skip.has(name)) continue;
    await rename(join(from, name), join(to, name));
    moved?.add(name);
  }
}

/**
 * `dir` 의 내용을 비우고 `fill()` 로 다시 채운다.
 *
 * @param dir      갈아 끼울 폴더. 존재해야 한다.
 * @param preserve `dir` 기준 상대 **파일** 경로. 있으면 새 내용 «위에» 되살린다.
 * @param keep     `dir` 바로 아래 이름. 치우지도 지우지도 않는다(위 KDoc).
 * @param fill     빈 `dir` 을 채우는 일. 던지면 전부 되돌린다.
 */
export async function replaceContents(
  dir: string,
  preserve: readonly string[],
  keep: readonly string[],
  fill: () => Promise<void>,
): Promise<ReplaceResult> {
  const skip = new Set(keep);

  // ⑴ 보존 대상을 먼저 읽는다 — 옮긴 뒤에는 그 경로가 없다.
  //    ⚠ **`catch {}` 로 뭉개지 마라.** 못 읽은 것을 「없다」로 읽으면 소속 표식이 잠시 안 읽히는
  //      날 폴더가 조용히 사이트에서 풀린다. 부재만 넘기고 나머지는 던진다.
  const held = new Map<string, Buffer>();
  for (const rel of preserve) {
    try {
      held.set(rel, await readFile(join(dir, rel)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  const real = await realpath(dir);
  const before = new Set(await readdir(real));
  const stash = await mkdtemp(join(dirname(real), STASH_PREFIX));
  const kept = [...before].filter((n) => skip.has(n));
  // ⚠ **«옮긴 것»과 «원래 있던 것»은 다르다.** 되돌릴 때 지우면 안 되는 것은 «옮기다 실패해
  //   자리에 남은 것»뿐이다. 원래 있던 이름 전부를 건너뛰면, 새 소스가 같은 이름을 쓸 때
  //   (`src`·`package.json` — 사실상 모든 zip) 그 새 것이 안 지워진 채 되돌리기가
  //   `ENOTEMPTY` 로 죽는다. 그러면 폴더가 옛것과 새것이 섞인 채 남고 나머지는 점(.) 형제에
  //   갇힌다 — 이 함수가 없애려던 그 형태가 다른 문으로 되살아난다(확인 심의 실측).
  const moved = new Set<string>();

  try {
    await moveAll(real, stash, skip, moved);
    await fill();
  } catch (cause) {
    // ⑵ 되돌리기 자체도 던질 수 있다. 그때 **원인을 잃지 않는다** — 사람이 봐야 하는 것은
    //    되돌리기의 errno 가 아니라 애초에 무엇이 실패했는가다.
    //
    // ⚠ **새로 쓴 것만 걷는다.** 폴더에 남은 것을 전부 지우려 들면 «옮기다 실패한 그 항목»
    //   까지 지우려다 같은 사유로 또 죽는다 — 되돌리기가 그 자리를 못 지나면 폴더가 갈린다
    //   (심의 실측: 권한 없는 디렉터리에서 되돌리기 전체가 멈췄다).
    try {
      for (const name of await readdir(real)) {
        if (skip.has(name) || (before.has(name) && !moved.has(name))) continue;
        await rm(join(real, name), { recursive: true, force: true });
      }
      await moveAll(stash, real);
      await rm(stash, { recursive: true, force: true });
    } catch (rollback) {
      throw new Error(
        `갈아 끼우기에 실패했고 되돌리기도 실패했습니다. 원래 소스는 ${stash} 에 있습니다.\n` +
          `원인: ${String(cause)}\n되돌리기: ${String(rollback)}`,
        { cause },
      );
    }
    throw cause;
  }

  // ⑶ 성공. 보존 파일을 새 소스 위에 얹는다.
  //
  // ⚠ **이 자리도 던질 수 있다.** 새 소스가 보존 경로와 같은 이름의 «파일»을 실어 오면
  //   `mkdir` 이 `EEXIST` 로 죽는다. 감싸지 않으면 예외가 맨몸으로 새어 나가고 치운 자리가
  //   영구히 남는다 — 폴더는 사이트 소속을 잃고 사람은 errno 만 본다(확인 심의 실측).
  const preserved: string[] = [];
  try {
    for (const [rel, bytes] of held) {
      await mkdir(dirname(join(real, rel)), { recursive: true });
      await writeFile(join(real, rel), bytes);
      preserved.push(rel);
    }
  } catch (cause) {
    throw new Error(
      `갈아 끼우기는 됐지만 보존 파일을 되살리지 못했습니다. 원래 소스는 ${stash} 에 있습니다.\n` +
        `원인: ${String(cause)}`,
      { cause },
    );
  } finally {
    // 성공이든 실패든 치운 자리는 남기지 않는다 — 실패했으면 위 문면이 그 경로를 말한다.
    if (preserved.length === held.size) await rm(stash, { recursive: true, force: true });
  }
  return { preserved, kept };
}
