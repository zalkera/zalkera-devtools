/**
 * **CLI 와 확장의 판이 같은가.**
 *
 * ## 왜 묶는가 — 게이트가 하나다
 *
 * 둘은 한 제품이고, 핸드셰이크의 최소판 게이트도 **하나**다(`min-extension-version`). CLI 가 자기
 * 판 축을 따로 가지면 서버가 「0.18 이상」이라 답할 때 CLI 의 `0.1.0` 이 **첫 호출에서 거절된다** —
 * 고객에게는 「업데이트하세요」만 뜨고, 업데이트할 새 판은 존재하지 않는다.
 *
 * ## 왜 검사기가 필요한가
 *
 * 판 올리기는 `package-vsix.mjs --bump` 이 하고 그것이 두 파일을 쓴다. 한쪽을 손으로 고치거나
 * 그 스크립트에서 한 줄이 빠지면 **조용히** 갈린다 — 갈린 사실은 고객 기계에서 처음 드러난다.
 *
 * ## 이 검사기가 못 하는 것
 *
 * 서버의 `min-extension-version` 이 실제로 얼마인지는 **모른다.** 그 값은 백엔드 설정이고 여기서
 * 안 보인다. 여기서 재는 것은 「두 판이 갈리지 않았는가」 하나다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const ext = read("../packages/vscode/package.json").version;
const cli = read("../packages/cli/package.json").version;

if (ext !== cli) {
    console.error(`❌ 판 축이 갈렸습니다 — 확장 ${ext} · CLI ${cli}`);
    console.error("   둘은 한 최소판 게이트를 지납니다. `npm run package:patch` 처럼 한 문으로 올리십시오.");
    process.exit(1);
}
console.log(`✓ 판 축 일치 — ${ext}`);
