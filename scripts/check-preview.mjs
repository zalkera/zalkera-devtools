#!/usr/bin/env node
/**
 * **미리보기 배지를 아무도 소유하지 않는 상태를 막는다.**
 *
 * ■ 왜 있나
 *   `preview: true` 는 마켓 목록에 「Preview」 배지를 띄우는 표시다. 설치도 검색도 막지 않으므로
 *   켜둔 채로 두어도 아무 데서도 아프지 않다 — 아프지 않으니 뗄 사람도 없다. 조건을 적어두지
 *   않으면 배지는 제품이 자란 뒤에도 그대로 남는다.
 *
 *   그래서 배지를 켜려면 **뗄 조건을 같이 선언**하게 하고, 조건이 충족돼 배지를 끄면 그 선언도
 *   함께 지우게 한다. 켜는 일도 끄는 일도 언제나 한 번의 눈에 보이는 편집이 된다.
 *
 *   조건은 레포 **루트** `package.json` 에 둔다. 확장 매니페스트는 손질 없이 VSIX 로 들어가
 *   고객이 열어 보는 파일이고(`scripts/package-vsix.mjs` 의 `staged = { ...manifest }`),
 *   해제 조건은 우리 사정이지 고객에게 할 말이 아니다. 그래서 확장 매니페스트 쪽에
 *   `zalkera.previewExit` 가 생기면 이 검사가 막는다.
 *
 *   `preview` 는 채널이 아니다. 배지를 켜도 받는 사람은 모두 같은 버전을 받는다. 채널을 나누는
 *   것은 `vsce publish --pre-release` 쪽이고, 이 검사는 거기에 관여하지 않는다.
 *
 *   재현: 루트 `package.json` 에서 `zalkera.previewExit` 를 지우고 `npm run check:preview`
 *
 * ■ 걸리면
 *   배지를 유지할 것이면 루트 `package.json` 의 `zalkera.previewExit` 에 **뗄 조건**을 적는다.
 *   배지를 뗄 것이면 확장 매니페스트의 `preview` 를 false 로 두고 그 선언도 함께 지운다.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "packages/vscode/package.json"); // VSIX 로 배송된다
const policyPath = join(root, "package.json"); // 배송되지 않는다

const give = (path) => {
    if (!existsSync(path)) {
        console.error(`❌ 미리보기 배지 검사 — ${relative(root, path)} 가 없습니다(통과가 아닙니다).`);
        process.exit(2);
    }
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        console.error(`❌ 미리보기 배지 검사 — ${relative(root, path)} 를 읽지 못했습니다(통과가 아닙니다): ${err.message}`);
        process.exit(2);
    }
};

const manifest = give(manifestPath);
const policy = give(policyPath);

const fail = (...lines) => {
    console.error(`❌ 미리보기 배지 검사 — ${lines[0]}`);
    for (const line of lines.slice(1)) console.error(`   → ${line}`);
    process.exit(1);
};

// 값이 사라지는 것도 결함이다. 키가 없으면 마켓은 배지 없음으로 읽는데, 그 변화가 매니페스트
// 어디에도 안 보인다. 켜든 끄든 **명시**하게 한다.
if (!Object.hasOwn(manifest, "preview")) {
    fail("확장 매니페스트에 `preview` 키가 없습니다.", "배지를 끌 생각이면 `\"preview\": false` 로 명시하십시오.");
}
if (typeof manifest.preview !== "boolean") {
    fail(
        `\`preview\` 가 boolean 이 아닙니다(받은 값: ${JSON.stringify(manifest.preview)}).`,
        "true 또는 false 로 적으십시오.",
    );
}

// 조건을 배지 옆에 두고 싶은 유혹이 크다. 거기는 배송물이다.
if (manifest.zalkera?.previewExit !== undefined) {
    fail(
        "해제 조건이 확장 매니페스트에 있습니다 — 이 파일은 VSIX 로 배송됩니다.",
        "루트 package.json 의 `zalkera.previewExit` 로 옮기십시오.",
    );
}

const exit = policy.zalkera?.previewExit;
const declared = typeof exit === "string" && exit.trim() !== "";

if (manifest.preview === true && !declared) {
    fail(
        "배지는 켜져 있는데 뗄 조건이 없습니다.",
        "루트 package.json 의 `zalkera.previewExit` 에 **무슨 일이 일어나면 뗄지**를 적으십시오.",
        "버전 숫자는 우리가 마음대로 올릴 수 있어 조건이 되지 못합니다 — 관측 가능한 사건으로 적으십시오.",
    );
}
if (manifest.preview === false && exit !== undefined) {
    fail(
        "배지는 껐는데 뗄 조건이 남아 있습니다.",
        "충족된 조건은 지웁니다 — 루트 package.json 의 `zalkera.previewExit` 를 삭제하십시오.",
    );
}

if (manifest.preview === true) {
    console.log("✅ 미리보기 배지 검사 — 통과 (배지 켜짐)");
    console.log(`   뗄 조건: ${exit.trim()}`);
} else {
    console.log("✅ 미리보기 배지 검사 — 통과 (배지 꺼짐)");
}
