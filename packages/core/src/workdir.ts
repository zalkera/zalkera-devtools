/**
 * **작업본을 sha 로 읽는 자리**(memo184 §2.2) — 로컬 폴더가 지금 무엇을 담고 있는가.
 *
 * ■ 왜 포장기(`packProject`)를 안 쓰나
 *
 * 포장기는 내용을 **전부 메모리에 올려** zip 을 만든다. pull 은 「무엇이 바뀌었나」만 알면 되고,
 * 그 답을 얻자고 사이트 전체를 램에 올릴 이유가 없다. 여기서는 파일을 **흘려 읽어** 해시만 남긴다.
 *
 * ■ 배제 **판정**을 포장기와 공유한다 — 목록을 옮겨 적지 않는다
 *
 * 여기는 [isExcludedEntry] 를 부르고, 포장기(`packProject`)는 같은 판정 셋(`isExcludedPath` ·
 * `ALWAYS_EXCLUDED` 세그먼트 · `isSecretFile`)을 훑는 동안 조각별로 부른다. 함수 이름이 같지 않은
 * 것은 포장기가 **뺀 비밀 파일의 이름을 말해야 하기** 때문이다(「조용히 빼지 않는다」) — 판정을
 * 통짜 경로로 한 번에 물으면 무엇이 왜 빠졌는지가 사라진다.
 *
 * ⚠ 이것이 갈리면 배제된 파일이 「로컬에만 있는 것」으로 잡혀 매번 무간섭 목록에 뜨거나 — 더
 *   나쁘게 — 충돌로 잡혀 pull 을 영구히 막는다. 실제로 `EXCLUDED_PREFIXES` 가 포장기 쪽에만 안
 *   닿아 「둘째 겹」이 이름뿐이던 적이 있다(심의 실측 · `isExcludedPath` 로 묶어 닫았다).
 */
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {lstat, readdir} from "node:fs/promises";
import {join, sep} from "node:path";
import {DevtoolsError} from "./errors.ts";
import {MAX_ENTRIES} from "./limits.ts";
import {isExcludedEntry} from "./zip.ts";

/** 작업본 매니페스트. 열쇠는 뿌리 기준 상대 경로(`/` 구분자)다 — 받을 매니페스트와 **같은 표기**. */
export type WorkdirManifest = Record<string, {sha256: string}>;

/**
 * 폴더를 훑어 파일별 sha256 을 낸다.
 *
 * ⚠ **심볼릭 링크는 세지 않는다.** 링크를 파일로 세면 그 sha 는 링크가 가리키는 **폴더 밖 내용**이
 *   되고, 그 값으로 「깨끗하다」를 판정하면 pull 이 폴더 밖 파일을 기준으로 덮어쓸지를 정하게 된다.
 * ⚠ 배제 폴더는 **걸러내는 게 아니라 들어가지 않는다** — `node_modules` 수만 개를 해시하고 버리면
 *   그 자체가 몇 분짜리 작업이다.
 */
export async function hashWorkdir(
    root: string,
    options: {maxEntries?: number} = {},
): Promise<WorkdirManifest> {
    const manifest: WorkdirManifest = {};
    const cap = Math.min(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
    let seen = 0;

    async function walk(dir: string, prefix: string): Promise<void> {
        const entries = await readdir(dir, {withFileTypes: true}).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
            throw error;
        });
        for (const item of entries) {
            const relative = prefix === "" ? item.name : `${prefix}/${item.name}`;
            if (isExcludedEntry(relative)) continue;
            // 벨트. 실효 판정은 아래 `isFile()` 과 짝이다 — `withFileTypes` 는 링크의 **자기 형식**을
            // 주므로 어느 한쪽만 있어도 링크는 걸러진다(변이 실측: 둘 다 빼야 시험이 깨진다).
            // 그래도 남기는 이유는 이 줄이 **의도를 적기** 때문이다.
            if (item.isSymbolicLink()) continue;
            if (item.isDirectory()) {
                await walk(join(dir, item.name), relative);
                continue;
            }
            if (!item.isFile()) continue;
            seen += 1;
            if (seen > cap) {
                throw new DevtoolsError(
                    "LOCAL_TOO_LARGE",
                    `이 폴더의 파일이 너무 많습니다(${cap}개 초과).`,
                    "사이트 폴더가 아닌 곳을 가리키고 있지 않은지 확인해 주세요.",
                );
            }
            manifest[relative] = {sha256: await hashFile(join(dir, item.name))};
        }
    }

    await walk(root, "");
    return manifest;
}

/** 파일 하나의 sha256. **흘려 읽는다** — 큰 파일 하나가 램을 통째로 먹지 않게. */
export async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/**
 * 뿌리 안의 기존 경로를 **링크를 안 따라가고** 편다. 없으면 `null`.
 *
 * 🔴 지우는 쪽이 이것을 지나야 한다. 장부(`.zalkera/sync.json`)는 **로컬 파일**이라 손으로 고칠 수도,
 *    남이 만든 zip 에 실려 올 수도 있다. 거기 적힌 경로를 그대로 `unlink` 하면 `../../` 한 줄로
 *    폴더 밖 파일이 지워진다. 받은 것만 검사하고 **가진 것을 안 검사하는** 구멍이다.
 */
export async function resolveExisting(root: string, path: string): Promise<string | null> {
    // 벨트. 널 바이트는 `lstat` 이 어차피 던지고 아래 `catch` 가 `null` 로 받는다. 여기서 먼저
    // 끊는 것은 **오류 경로에 기대지 않기 위해서**다.
    if (path === "" || path.includes("\0")) return null;
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 0) return null;
    if (segments.some((s) => s === "." || s === ".." || s.includes(sep))) return null;
    let current = root;
    for (const part of segments) {
        const next = join(current, part);
        const info = await lstat(next).catch(() => null);
        if (!info || info.isSymbolicLink()) return null;
        current = next;
    }
    return current;
}
