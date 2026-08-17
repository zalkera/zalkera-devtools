import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
    isUsableVersion,
    shouldShowUpgradeNotice,
    UPGRADE_NOTICE_INTERVAL_MS,
    type UpgradeNoticeState,
} from "./upgradeNotice.ts";

const DAY = UPGRADE_NOTICE_INTERVAL_MS;
const NOW = 1_700_000_000_000;

test("처음 보는 권고 버전은 띄운다", () => {
    strictEqual(shouldShowUpgradeNotice("0.1.40", null, NOW), true);
});

test("같은 버전을 방금 띄웠으면 다시 안 띄운다", () => {
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW - 1_000 };
    strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW), false);
});

test("같은 버전이라도 하루가 지나면 다시 띄운다", () => {
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW - DAY };
    strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW), true);
});

test("하루에서 1ms 모자라면 아직 안 띄운다 — 경계", () => {
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW - DAY + 1 };
    strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW), false);
});

test("새 권고 버전은 억제를 무시하고 즉시 띄운다", () => {
    // ⚠ 이것이 억제의 목적이다. 버전 비교 없이 시간만 보면 **더 급한 소식이 하루 늦는다.**
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW - 1_000 };
    strictEqual(shouldShowUpgradeNotice("0.1.41", last, NOW), true);
});

test("권고 버전이 없거나 비면 안 띄운다", () => {
    for (const bad of [null, undefined, "", "   "]) {
        strictEqual(shouldShowUpgradeNotice(bad as string | null, null, NOW), false, String(bad));
    }
});

test("문자열이 아닌 값이 와도 안 띄운다 — 서버 응답은 우리 타입이 아니다", () => {
    for (const bad of [0, 1, {}, [], true]) {
        strictEqual(shouldShowUpgradeNotice(bad as unknown as string, null, NOW), false, String(bad));
    }
});

test("저장된 값이 깨져 있어도 던지지 않는다", () => {
    // globalState 는 예전 판이 쓴 모양을 그대로 돌려준다.
    for (const junk of [{}, {version: "0.1.40"}, {shownAt: NOW}, "문자열"]) {
        const v = shouldShowUpgradeNotice("0.1.40", junk as unknown as UpgradeNoticeState, NOW);
        strictEqual(typeof v, "boolean", JSON.stringify(junk));
    }
});

test("미래에 띄운 기록은 억제로 안 쓴다 — 영구 억제가 된다", () => {
    // ⚠ 종전 시험은 여기서 `false` 를 못 박아 **결함을 고정**했다. 스냅샷 복원·CMOS 방전으로 시계가
    //   1년 앞섰다가 고쳐지면, 그 사이 남은 기록이 그 권고 판을 **그 시각까지** 막는다.
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW + 365 * DAY };
    strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW), true);
    strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW + 30 * DAY), true);
});

test("판 표기 형태가 아니면 아무것도 안 한다", () => {
    for (const bad of ["9".repeat(1_000_000), "latest", "0.1", "v0.1.40", "0.1.40; rm -rf /", "0.1.40 ", "1e6.0.0"]) {
        strictEqual(shouldShowUpgradeNotice(bad, null, NOW), false, JSON.stringify(bad.slice(0, 20)));
        strictEqual(isUsableVersion(bad), false, JSON.stringify(bad.slice(0, 20)));
    }
    for (const good of ["0.1.40", "1.0.0", "10.20.30", "0.1.40-rc.1"]) ok(isUsableVersion(good), good);
});

test("저장된 shownAt 이 숫자가 아니면 억제로 안 쓴다", () => {
    for (const junk of ["어제", null, undefined, NaN, Infinity]) {
        const last = { version: "0.1.40", shownAt: junk } as unknown as UpgradeNoticeState;
        strictEqual(shouldShowUpgradeNotice("0.1.40", last, NOW), true, String(junk));
    }
});

test("간격은 24시간이다", () => {
    strictEqual(UPGRADE_NOTICE_INTERVAL_MS, 86_400_000);
});

test("판정은 상태를 안 바꾼다 — 순수 함수", () => {
    const last: UpgradeNoticeState = { version: "0.1.40", shownAt: NOW - 1_000 };
    const before = structuredClone(last);
    shouldShowUpgradeNotice("0.1.41", last, NOW);
    deepStrictEqual(last, before);
    ok(true);
});
