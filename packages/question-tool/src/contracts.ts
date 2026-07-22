export const PACKAGE_SCHEMA_VERSION = 1 as const;
export const CORE_PROTOCOL_VERSIONS = [1] as const;
export const HANDLER_ID = "dev.taylorrowser.pi-question-tool.question" as const;
export const HANDLER_VERSION = 1 as const;
export const RESUMABLE_HANDLER_VERSIONS = [HANDLER_VERSION] as const;

export const REQUEST_ENTRY_TYPE =
	"dev.taylorrowser.pi-question-tool/request" as const;
export const OUTCOME_ENTRY_TYPE =
	"dev.taylorrowser.pi-question-tool/outcome" as const;

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface QuestionDefinition {
	id: string;
	label: string;
	question: string;
	options: QuestionOption[];
}

export interface QuestionSetInput {
	questions: Array<{
		id: string;
		label?: string;
		question: string;
		options: QuestionOption[];
	}>;
}

export function isCustomAnswerPlaceholder(option: QuestionOption): boolean {
	const label = option.label
		.trim()
		.toLowerCase()
		.replace(/[.…:]+$/u, "");
	return (
		/^(other|custom|custom answer|something else)(?:\s*\([^)]*\))?$/u.test(
			label,
		) ||
		/\bplease specify\b/u.test(label) ||
		/^(type|write|enter)\b.*\b(answer|response|something)\b/u.test(label)
	);
}

export function normalizeQuestionSet(
	input: QuestionSetInput,
): QuestionDefinition[] {
	const ids = new Set<string>();
	return input.questions.map((question, index) => {
		if (ids.has(question.id))
			throw new Error(`Question id must be unique: ${question.id}`);
		ids.add(question.id);

		const options = question.options.filter(
			(option) => !isCustomAnswerPlaceholder(option),
		);
		if (options.length === 0) {
			throw new Error(
				`Question ${question.id} must provide at least one concrete supplied choice; the custom-answer row is added automatically.`,
			);
		}

		return {
			...question,
			label: question.label?.trim() || `Q${index + 1}`,
			options,
		};
	});
}
