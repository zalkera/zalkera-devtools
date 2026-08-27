import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { inspectProject } from "./project.ts";

/**
 * D1「배포 전 검사」 — **조언이지 차단이 아니다.**
 *
 * 이 구분이 이 파일의 전부다. 게이트의 상한은 "빌드 green + 산출물 보장"(memo125 §4)이고, **서버가 받아 줄
 * 것을 확장이 먼저 막으면 소스 재업로드 경로를 우리 손으로 좁히는 것**이 된다 — memo138 §3.3 이 금지한
 * "한쪽을 불편하게 만들기"를 우리가 실행하는 자리다. 그래서 여기서 나오는 모든 항목은 **경고이고, 발행을
 * 막지 않는다.** 호출부(확장·CLI)도 이 결과로 발행을 취소해서는 안 된다 — 사람에게 보여 주고 사람이 정한다.
 */
export interface PrecheckFinding {
    level: "info" | "warn";
    message: string;
    /** 사람이 다음에 할 일(있으면). */
    hint?: string;
}

export interface PrecheckOptions {
    projectDir: string;
    /** 핸드셰이크가 알려 준 `@zalkera/client` 최소 버전(있으면 대조한다). */
    minClientVersion?: string;
}

/** 발행 전에 훑는다. **아무것도 막지 않는다** — 반환값은 사람에게 보여 줄 말의 목록이다. */
export async function precheck(options: PrecheckOptions): Promise<PrecheckFinding[]> {
    const findings: PrecheckFinding[] = [];
    const project = await inspectProject(options.projectDir);

    findings.push({ level: "info", message: `사이트: ${project.name}` });

    if (!project.hasNext) {
        findings.push({
            level: "warn",
            message: "의존성에 next 가 없습니다.",
            hint: "서버는 Next 산출물을 기대합니다. 다른 스택이라면 무시해도 됩니다.",
        });
    }

    if (options.minClientVersion && project.clientVersion) {
        const declared = project.clientVersion.replace(/^[\^~>=<\s]+/, "");
        if (compareVersions(declared, options.minClientVersion) < 0) {
            findings.push({
                level: "warn",
                message: `@zalkera/client 가 ${declared} 로 선언돼 있습니다(서버 권장 ${options.minClientVersion} 이상).`,
                hint: "낮은 버전은 최신 데이터 계약을 모를 수 있습니다.",
            });
        }
    } else if (!project.clientVersion) {
        findings.push({
            level: "info",
            message: "@zalkera/client 선언이 없습니다.",
            hint: "서버 데이터를 쓰지 않는 사이트라면 정상입니다.",
        });
    }

    // ⚠ **이 도구 자신이 사이트 의존에 들어와 있는가.** 형제 `@zalkera/client` 와 스코프가 같아
    //   에이전트가 형제 패키지로 보고 프로젝트에 설치하는 일이 있다. 그러면 그 `package.json` 이
    //   업로드돼 **서버 빌드가 CLI 를 설치한다** — 쓰지도 않는 것을 짓느라 시간과 용량을 쓴다.
    //   `warn` 이다: 빌드가 죽지는 않으므로 막지 않고 말한다.
    if (project.toolInDeps.length > 0) {
        findings.push({
            level: "warn",
            message: `${project.toolInDeps.join(" · ")} 가 이 사이트의 의존으로 들어 있습니다.`,
            hint: "이것은 소스가 `import` 하는 패키지가 아니라 터미널에서 치는 명령입니다. `package.json` 에서 빼 주세요 — 그대로 두면 사이트를 지을 때 함께 설치됩니다.",
        });
    }

    if (!existsSync(join(options.projectDir, ".gitignore"))) {
        findings.push({
            level: "info",
            message: ".gitignore 가 없습니다.",
            hint: "git 을 쓰지 않는다면 정상입니다. 쓴다면 .env.local 을 꼭 무시하세요.",
        });
    }

    const heavy = await findHeavyFiles(options.projectDir);
    for (const item of heavy) {
        findings.push({
            level: "warn",
            message: `큰 파일: ${item.path} (${Math.round(item.size / 1024 / 1024)}MB)`,
            hint: "업로드 상한은 100MB 입니다. 동영상·원본 이미지는 빼는 편이 좋습니다.",
        });
    }

    return findings;
}

interface HeavyFile {
    path: string;
    size: number;
}

const HEAVY_BYTES = 5 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "out", ".turbo", ".vercel"]);

async function findHeavyFiles(dir: string, root = dir, found: HeavyFile[] = []): Promise<HeavyFile[]> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(item.name) || found.length >= 10) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) {
            await findHeavyFiles(full, root, found);
        } else if (item.isFile()) {
            const info = await stat(full);
            if (info.size >= HEAVY_BYTES) found.push({ path: relative(root, full), size: info.size });
        }
    }
    return found;
}

/** 느슨한 semver 비교(숫자 자리만). 범위 표기(`^1.2.0`)는 호출부가 이미 걷어서 넘긴다. */
function compareVersions(left: string, right: string): number {
    const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
