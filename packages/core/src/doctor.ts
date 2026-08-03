import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchHandshake } from "./handshake.ts";
import { inspectProject } from "./project.ts";

/**
 * 진단(F5) — **"왜 안 되는지"를 사람 말로 한 번에 보여 준다.**
 *
 * 지원 비용의 대부분은 "안 돼요"에서 원인을 좁히는 왕복이다. 이 함수 하나가 그 왕복을 없애는 것이 목표이고,
 * 특히 사내망 프록시(§10-5)처럼 **우리 코드가 아니라 환경이 원인**인 경우를 눈에 보이게 만든다.
 */
export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
    /** 사람이 다음에 할 일(있으면). */
    hint?: string;
}

export interface DoctorOptions {
    apiBase: string;
    extensionVersion: string;
    projectDir?: string;
    fetchImpl?: typeof fetch;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    const major = Number(process.versions.node.split(".")[0]);
    checks.push({
        name: "Node 실행 환경",
        ok: major >= 20,
        detail: `Node ${process.versions.node} (${process.platform}/${process.arch})`,
        ...(major >= 20 ? {} : { hint: "Node 20 이상이 필요합니다. 확장으로 쓰면 따로 깔 필요가 없습니다." }),
    });

    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    checks.push({
        name: "네트워크 프록시",
        ok: true,
        detail: proxy ? `프록시 설정됨: ${proxy}` : "프록시 설정 없음",
        ...(proxy
            ? { hint: "사내망 프록시가 있으면 로그인 창·의존성 내려받기가 막힐 수 있습니다. 막히면 이 값을 관리자에게 알려 주세요." }
            : {}),
    });

    try {
        const handshake = await fetchHandshake(
            options.apiBase,
            options.extensionVersion,
            options.fetchImpl ?? fetch,
        );
        checks.push({
            name: "잘커라 서버 연결",
            ok: true,
            detail: `연결됨 · 판정 ${handshake.verdict}${handshake.message ? ` — ${handshake.message}` : ""}`,
            ...(handshake.verdict === "UPGRADE_RECOMMENDED" ? { hint: "확장을 업데이트하면 좋습니다." } : {}),
        });
    } catch (error) {
        checks.push({
            name: "잘커라 서버 연결",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            hint: "주소·인터넷·프록시를 확인해 주세요.",
        });
    }

    if (options.projectDir) {
        try {
            const project = await inspectProject(options.projectDir);
            checks.push({
                name: "사이트 소스",
                ok: true,
                detail: `${project.name} · Next ${project.hasNext ? "있음" : "없음"} · @zalkera/client ${project.clientVersion ?? "선언 없음"}`,
                ...(project.hasNext ? {} : { hint: "개발 서버(next)가 의존성에 없습니다. 소스가 맞는지 확인해 주세요." }),
            });
            checks.push({
                name: "의존성",
                ok: project.hasNodeModules,
                detail: project.hasNodeModules ? "설치됨" : "미설치",
                ...(project.hasNodeModules ? {} : { hint: "프리뷰를 켜면 자동으로 준비합니다." }),
            });
            const envPath = join(options.projectDir, ".env.local");
            checks.push({
                name: "로컬 설정 파일",
                ok: true,
                detail: existsSync(envPath) ? ".env.local 있음" : ".env.local 없음(프리뷰를 켜면 만듭니다)",
            });
        } catch (error) {
            checks.push({
                name: "사이트 소스",
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
                hint: "사이트 소스 폴더를 골라 주세요.",
            });
        }
    }

    return checks;
}
