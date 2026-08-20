/**
 * **시험 임시 폴더 — 만드는 문이 곧 지우는 문이다.**
 *
 * ■ 왜 한 곳에 모으나
 *   시험 17개 파일이 `mkdtemp` 를 제각기 불렀고, 그중 회수까지 하는 것은 여섯이었다. 나머지는
 *   실행마다 폴더를 `TMPDIR` 에 남겼다 — 이 박스의 기본 `TMPDIR` 은 tmpfs(메모리)다. 그리고
 *   `blockers.test.ts` 하나가 **101MB** 픽스처를 쓴다. 「자리마다 손으로 적으면 하나씩 빠진다」는
 *   그 파일이 이미 적어 둔 문장인데, 정작 그 규율이 그 파일 안에만 있었다.
 *
 *   가드를 재는 시험이 가드가 막으려는 손해를 내면 안 된다.
 *
 * ■ 회수를 두 겹으로 두는 이유
 *   ⑴ `after` — 정상 종료와 시험 실패를 덮는다.
 *   ⑵ `process.on("exit")` + 동기 삭제 — `after` 가 못 도는 길(모듈 평가 중 예외·`process.exit`)을
 *      덮는다. 종료 훅에서는 비동기가 완주하지 못하므로 **동기**여야 한다.
 *   SIGKILL 은 어느 쪽도 못 덮는다. 그래서 큰 픽스처는 **희소 파일**로 만든다(`truncate`) —
 *   죽어도 실제로 남는 바이트가 없다.
 *
 * ■ 왜 `src/testing/` 인가
 *   `tsconfig.json` 이 이 폴더를 굽지 않는다(`exclude`). 시험 전용 코드가 `dist` 에 섞이면
 *   발행 꾸러미와 빌드 시간만 커지고 그 사실이 아무 데서도 안 보인다 — `check-dist-purity.mjs`
 *   가 그 둘(`*.test.*` 과 이 폴더)을 함께 지킨다.
 *
 * 재현: `TMPDIR=$(mktemp -d) npm test && du -sh $TMPDIR`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const roots: string[] = [];

/** 만든 것을 전부 지운다. 하나가 실패해도 나머지를 계속 지운다 — 하나 때문에 전부 남으면 안 된다. */
async function sweep(): Promise<void> {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
}

after(sweep);

process.on("exit", () => {
    for (const root of roots.splice(0)) {
        try {
            rmSync(root, { recursive: true, force: true });
        } catch {
            /* 종료 중이다 — 지우지 못한 것을 보고할 자리가 없다. */
        }
    }
});

/** 임시 폴더를 만들고 회수 목록에 올린다. */
export async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

/** 동기 판. 모듈 평가 중에 픽스처가 필요한 자리가 있다. */
export function tempDirSync(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}
