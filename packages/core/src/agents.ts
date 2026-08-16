import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeOwnFile } from "./safeWrite.ts";

/**
 * E1「규약 파일 점검」(memo146 §5 E1 · §7).
 *
 * **내용을 지어 넣지 않는다.** 지침의 정본은 `llms.txt`(패키지 동봉)이고, 중립 자리는 소스 팩이 함께 주는
 * `AGENTS.md` 다. 확장이 여기에 규약을 복사하는 순간 그것은 §7 이 금지한 **드리프트 사본**이 된다 —
 * 팩이 바뀌어도 사본은 안 바뀌고, 에이전트는 낡은 것을 읽는다.
 *
 * 그래서 하는 일은 셋뿐이다.
 * 1. `AGENTS.md` 가 있으면 **손대지 않는다**(팩이 준 정본이다).
 * 2. 없으면(자기 소스를 연결한 경우) **포인터 스텁**만 만든다 — 내용 복사 0.
 * 3. `CLAUDE.md` 가 없으면 한 줄 import 파일을 만든다. 이것은 벤더 전용 "스킬"이 아니라 **참조 한 줄**이라
 *    드리프트할 내용 자체가 없다. 이미 있으면 손대지 않는다.
 */
export interface AgentDocsResult {
    agents: "kept" | "created";
    claude: "kept" | "created";
}

const MARKER = "<!-- zalkera-devtools 가 만든 스텁입니다. 내용을 여기 쓰지 말고 정본을 고치세요. -->";

const AGENTS_STUB = `${MARKER}
# 이 사이트 소스의 규약

규약의 정본은 이 파일이 아니라 **\`@zalkera/client\` 에 동봉된 \`llms.txt\`** 입니다.

- 설치돼 있으면: \`node_modules/@zalkera/client/llms.txt\`
- 데이터는 서버가 정본입니다 — 상품·글·설정 값을 소스에 복사하지 마세요.
- \`.env.local\` 은 자격증명이 들어 있어 **커밋하지 않습니다.**
`;

const CLAUDE_POINTER = `${MARKER}
@AGENTS.md
`;

export async function ensureAgentDocs(projectDir: string): Promise<AgentDocsResult> {
    const agentsPath = join(projectDir, "AGENTS.md");
    const claudePath = join(projectDir, "CLAUDE.md");

    let agents: AgentDocsResult["agents"] = "kept";
    if (!existsSync(agentsPath)) {
        await writeOwnFile(agentsPath, AGENTS_STUB);
        agents = "created";
    }

    let claude: AgentDocsResult["claude"] = "kept";
    if (!existsSync(claudePath)) {
        await writeOwnFile(claudePath, CLAUDE_POINTER);
        claude = "created";
    }

    return { agents, claude };
}
