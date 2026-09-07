/**
 * **「이 폴더」의 판 지문**(memo191) — 지금 이 폴더를 올리면 **서버에 남을 판**의 지문.
 *
 * ■ 왜 폴더를 그냥 접으면 안 되나
 *   폴더와 서버 판 사이에 기계 둘이 끼어 있고, 둘 다 목록을 바꾼다:
 *   ⑴ 우리 포장기(`packProject`) — 자기 배제 규칙을 돌리고, 값이 든 서식을 떨구고,
 *      **`.zalkera/provenance.json` 을 새로 만들어 넣는다**.
 *   ⑵ 서버 정규화(`serverExcluded`) — 자기 배제 규칙을 한 번 더 돌린다.
 *
 *   종전 판은 ⑴의 앞부분만 보고 ⑵와 주입을 안 봤다. 그래서 **devtools 로 발행하면 성공 직후부터
 *   영구히 「다름」**이었고(주입된 파일이 서버 판에만 있다), 시작 소스 팩으로 시작한 폴더는
 *   **첫 화면부터 「다름」**이었다(팩 20종이 싣는 `.github/workflows/` 둘을 서버만 뺀다). 심의 실측.
 *
 * ■ 순서가 규칙의 일부다 — **언랩 먼저, 배제 나중**
 *   서버는 zip 을 통째로 풀어 놓고 `effectiveRoot` 로 래퍼를 벗긴 **뒤에** 배제를 돌린다. 그래서
 *   래퍼 판정의 입력은 **배제 전 목록**이다. 순서를 뒤집으면 「루트에 `.env` 하나 + 폴더 하나」인 zip 에서
 *   서버는 안 벗기고 우리는 벗겨, 같은 소스가 갈린다(심의 실측).
 *
 * ■ 이 값이 대답하는 물음
 *   「지금 발행을 누르면 라이브가 바뀌는가.」 같으면 안 바뀐다. 그래서 콘솔 zip 으로 올라간 판과는
 *   다르게 나올 수 있고(그쪽은 우리 포장 규칙을 안 지났다), 그때의 「다름」은 **참말**이다 —
 *   그 폴더를 발행하면 실제로 다른 판이 선다.
 */
import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import {buildProvenance, PROVENANCE_PATH} from "./provenance.ts";
import {serverExcluded} from "./serverNormalization.ts";
import {sourceVersionDigest, unwrapSingleRoot} from "./sourceVersion.ts";
import {isValueLessTemplate, templateBreach} from "./zip.ts";
import {hashWorkdir} from "./workdir.ts";

/** 이 크기를 넘는 서식은 읽지 않고 떨군다 — `templateBreach` 의 내부 상한(256KB)과 같은 자리다. */
const TEMPLATE_SCAN_MAX_BYTES = 256 * 1024;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * [root] 폴더의 판 지문. [tenant] 는 출처 표시를 찍을 사이트 — **연결 안 된 폴더면 `null`**
 * (그때는 포장기도 안 찍는다). 모르면 `null` 을 돌려준다(빈 폴더·읽기 실패).
 */
export async function folderVersionDigest(root: string, tenant: string | null): Promise<string | null> {
    return (await folderVersionSummary(root, tenant)).digest;
}

/**
 * [folderVersionDigest] 와 같은 계산이되 **접은 항목 수**를 함께 돌려준다.
 *
 * 🔴 포장 갭을 알릴 때 이 수를 써야 한다. `PackResult.fileCount` 는 **우리 배제만** 지난 zip 항목 수이고,
 *    서버가 돌려주는 수는 **서버 배제 + 언랩까지** 지난 값이라 **모집단이 다르다**. 두 값을 나란히 놓으면
 *    시작 소스 팩(`.github/workflows/` 둘을 서버만 뺀다)에서 「로컬 42 / 서버 40」이 떠, 정상 차이를
 *    결함처럼 보이게 한다(심의 지적).
 */
export async function folderVersionSummary(
    root: string,
    tenant: string | null,
): Promise<{digest: string | null; fileCount: number}> {
    const manifest = await hashWorkdir(root);
    const entries: {path: string; sha256: string}[] = [];
    for (const [path, {sha256}] of Object.entries(manifest)) {
        // 값이 든 서식은 포장기가 떨군다 — 여기서도 떨궈야 예측이 맞는다.
        if (await breaches(root, path)) continue;
        entries.push({path, sha256});
    }
    // ⚠ **소스가 하나도 없으면 판도 없다**(모름). 아래 출처 표시는 우리가 넣는 기록물이라, 그것만
    //    남은 목록을 판이라 부르면 **빈 폴더가 지문을 갖는다** — 견줄 것이 없는데 「다름」이라 말하게 된다.
    if (entries.length === 0) return {digest: null, fileCount: 0};
    // 포장기가 **새로 만들어 넣는** 항목. 서버 판에는 있고 폴더에는 없다.
    if (tenant !== null) {
        entries.push({path: PROVENANCE_PATH, sha256: sha256Hex(buildProvenance(tenant))});
    }

    // ⚠ 언랩이 먼저다(위 KDoc) — 서버가 배제 전 목록으로 래퍼를 판정한다.
    const unwrapped = unwrapSingleRoot(entries.map((e) => e.path));
    const kept = entries
        .map((e, i) => ({path: unwrapped[i]!, sha256: e.sha256}))
        .filter((e) => !serverExcluded(e.path));
    return {digest: sourceVersionDigest(kept), fileCount: kept.length};
}

/**
 * 이름으로 서식 예외를 받은 파일이 값을 담고 있는가. **그 이름이 아니면 읽지 않는다.**
 *
 * ⚠ 크기를 먼저 본다 — `templateBreach` 는 상한을 자기 안에서 보는데, 그때는 이미 파일이 통째로
 *   램에 올라와 있다. 저장할 때마다 도는 자리라 큰 파일 하나가 그 비용을 매번 물린다.
 *   상한을 넘으면 **읽지 않고 떨군다** — 포장기도 그 파일을 안 담으므로 결과가 같다.
 */
async function breaches(root: string, path: string): Promise<boolean> {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    // ⚠ **포장기와 같은 술어를 쓴다 — 사본을 두지 않는다.** 접미(`.example`·`.sample`·`.template`)만
    //   보면 `fixtures/seed.sample` 처럼 `.env` 와 무관한 파일까지 걸려, 포장기는 담는데 예측은
    //   빼게 된다(발행 뒤 거짓 「다름」). 서식 예외는 `.env` 로 시작하는 이름에만 준다.
    if (!isValueLessTemplate(name)) return false;
    const full = join(root, path);
    try {
        if ((await stat(full)).size > TEMPLATE_SCAN_MAX_BYTES) return true;
        return templateBreach(name, await readFile(full)) !== null;
    } catch {
        // 못 읽으면 포장기도 못 담는다 — 목록에서 뺀다(모름을 값으로 만들지 않는다).
        return true;
    }
}
