import postgres from "postgres";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
// ../../packages/database/dist/index.js
function createDatabase(url, maximumConnections = 10) {
	const sql = postgres(url, {
		max: maximumConnections,
		idle_timeout: 20,
		connect_timeout: 5,
		prepare: false,
		transform: { undefined: null }
	});
	return {
		async transaction(operation) {
			return await sql.begin(async (transaction) => operation({ async query(text, values = []) {
				return [...await transaction.unsafe(text, values)];
			} }));
		},
		async health() {
			await sql`select 1`;
		},
		async close() {
			await sql.end({ timeout: 5 });
		}
	};
}
// ../../packages/contracts/dist/money.js
const MoneyCentsSchema = z.string().regex(/^(0|[1-9]\d{0,15})$/).refine((value) => BigInt(value) <= 9000000000000000n, "Valor fora do limite");
const PositiveMoneySchema = MoneyCentsSchema.refine((value) => BigInt(value) > 0n, "O valor deve ser positivo");
// ../../packages/contracts/dist/commercial.js
const quantity = z.string().regex(/^(0|[1-9]\d{0,11})$/);
const CatalogItemSchema = z.object({
	id: z.uuid(),
	sku: z.string().trim().min(1).max(30),
	name: z.string().trim().min(2).max(160),
	kind: z.enum([
		"product",
		"service",
		"material"
	]),
	category: z.string().trim().min(2).max(80),
	unit: z.enum([
		"un",
		"m",
		"m²",
		"h",
		"chapa"
	]),
	costCents: MoneyCentsSchema,
	priceCents: MoneyCentsSchema,
	openingStockMilli: quantity,
	minStockMilli: quantity,
	/** Estoque máximo; sem ele, não há teto (a barra enche a partir de três vezes o mínimo). */
	maxStockMilli: quantity.refine((value) => BigInt(value) > 0n, "O máximo precisa ser positivo").optional(),
	active: z.boolean(),
	/** Classificação fiscal do item para a NF-e; sem ela, vale o NCM padrão dos dados fiscais. */
	ncm: z.string().regex(/^\d{8}$/).optional()
});
/** Foto do item: já reduzida no aparelho (data URL de até ~300 kB), guardada à parte do estado comercial. */
const CatalogPhotoSchema = z.string().max(4e5, "A foto ficou grande demais.").regex(/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/, "Imagem inválida.");
z.record(z.uuid(), CatalogPhotoSchema);
const CatalogPhotoBodySchema = z.object({ image: CatalogPhotoSchema.nullable() }).strict();
const QuoteLineSchema = z.object({
	id: z.uuid(),
	productId: z.uuid(),
	sku: z.string(),
	description: z.string().min(2),
	kind: CatalogItemSchema.shape.kind,
	category: z.string(),
	unit: CatalogItemSchema.shape.unit,
	quantityMilli: quantity.refine((value) => BigInt(value) > 0n, "Quantidade deve ser positiva"),
	unitPriceCents: MoneyCentsSchema,
	unitCostCents: MoneyCentsSchema
});
const QuoteSchema = z.object({
	id: z.uuid(),
	code: z.string().min(1),
	title: z.string().trim().min(2).max(120),
	customerName: z.string().trim().min(2).max(160),
	owner: z.string().trim().min(2).max(80),
	createdOn: z.iso.date(),
	validUntil: z.iso.date(),
	dueDate: z.iso.date(),
	status: z.enum([
		"draft",
		"sent",
		"approved",
		"lost"
	]),
	approvedOn: z.iso.date().nullable(),
	revision: z.number().int().positive(),
	discountCents: MoneyCentsSchema,
	shippingCents: MoneyCentsSchema,
	shippingCostCents: MoneyCentsSchema,
	notes: z.string().max(3e3),
	items: z.array(QuoteLineSchema).min(1).max(100)
});
const CommercialProjectSchema = z.object({
	id: z.uuid(),
	quoteId: z.uuid(),
	stage: z.enum([
		"purchasing",
		"production",
		"installation",
		"delivered",
		"cancelled"
	]),
	version: z.number().int().positive(),
	dueDate: z.iso.date(),
	createdOn: z.iso.date()
});
const CommercialPaymentSchema = z.object({
	id: z.uuid(),
	commandId: z.uuid(),
	projectId: z.uuid(),
	amountCents: PositiveMoneySchema,
	receivedOn: z.iso.date(),
	method: z.enum([
		"Pix",
		"Transferência",
		"Cartão",
		"Dinheiro"
	])
});
/** Parcela a receber de um projeto (entrada, 1ª, 2ª...): o plano soma o valor do contrato; o que já entrou paga as
* parcelas na ordem do vencimento. */
const InstallmentSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	dueOn: z.iso.date(),
	amountCents: PositiveMoneySchema
});
const OperatingExpenseSchema = z.object({
	id: z.uuid(),
	description: z.string(),
	category: z.string(),
	quoteId: z.uuid().nullable(),
	amountCents: PositiveMoneySchema,
	incurredOn: z.iso.date(),
	paidOn: z.iso.date().nullable()
});
const InventoryMovementSchema = z.object({
	id: z.uuid(),
	productId: z.uuid(),
	deltaMilli: z.string().regex(/^-?[1-9]\d{0,11}$/),
	reason: z.string().trim().min(5).max(300),
	occurredOn: z.iso.date(),
	/** Entrada de compra: de quem e por quanto a unidade (o custo do item vira o custo médio). */
	supplier: z.string().trim().min(1).max(120).optional(),
	unitCostCents: MoneyCentsSchema.optional()
});
const GoalSchema = z.object({
	start: z.iso.date(),
	end: z.iso.date(),
	owner: z.string(),
	salesCents: PositiveMoneySchema,
	marginBasisPoints: z.number().int().min(0).max(1e4)
});
/** Painel de controle: preferências de cada pessoa e padrões da empresa; o que faltar volta ao valor de fábrica. */
const UserSettingsSchema = z.object({
	theme: z.enum([
		"auto",
		"light",
		"dark"
	]).default("auto"),
	largeText: z.boolean().default(false)
});
const CompanySettingsSchema = z.object({
	quoteValidityDays: z.number().int().min(1).max(365).default(14),
	deliveryDays: z.number().int().min(1).max(730).default(42),
	/** Margem prevista abaixo desta aparece em alerta no orçamento. */
	minMarginPercent: z.number().int().min(0).max(90).default(25),
	defaultOwner: z.string().trim().max(80).default(""),
	/** Condições que já entram no orçamento novo (e saem na proposta do cliente). */
	quoteTerms: z.string().trim().max(3e3).default(""),
	paymentMethod: CommercialPaymentSchema.shape.method.default("Pix")
});
const SettingsSchema = z.object({
	user: UserSettingsSchema,
	company: CompanySettingsSchema,
	companyName: z.string()
});
const CompanySettingsBodySchema = z.object({
	name: z.string().trim().min(2).max(160),
	settings: CompanySettingsSchema
}).strict();
const AnalyticsFilterSchema = z.object({
	start: z.iso.date(),
	end: z.iso.date(),
	owner: z.string(),
	compare: z.boolean()
});
const DemoCommercialStateSchema = z.object({
	schemaVersion: z.literal(2),
	referenceDate: z.iso.date(),
	products: z.array(CatalogItemSchema),
	quotes: z.array(QuoteSchema),
	projects: z.array(CommercialProjectSchema),
	payments: z.array(CommercialPaymentSchema),
	installments: z.array(InstallmentSchema).default([]),
	expenses: z.array(OperatingExpenseSchema),
	inventory: z.array(InventoryMovementSchema),
	versions: z.array(z.object({
		id: z.uuid(),
		quoteId: z.uuid(),
		revision: z.number().int().positive(),
		snapshot: QuoteSchema,
		reason: z.string(),
		createdOn: z.iso.date()
	})),
	goals: z.array(GoalSchema)
});
const CommercialCommandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("saveCatalogItem"),
		item: CatalogItemSchema
	}),
	z.object({
		type: z.literal("moveInventory"),
		movement: InventoryMovementSchema
	}),
	z.object({
		type: z.literal("saveQuote"),
		quote: QuoteSchema,
		eventId: z.uuid()
	}),
	z.object({
		type: z.literal("approveQuote"),
		quoteId: z.uuid(),
		revision: z.number().int().positive(),
		projectId: z.uuid(),
		eventId: z.uuid()
	}),
	z.object({
		type: z.literal("addPayment"),
		payment: CommercialPaymentSchema,
		expectedVersion: z.number().int().positive()
	}),
	z.object({
		type: z.literal("moveProject"),
		projectId: z.uuid(),
		stage: CommercialProjectSchema.shape.stage,
		expectedVersion: z.number().int().positive()
	}),
	z.object({
		type: z.literal("planInstallments"),
		projectId: z.uuid(),
		installments: z.array(InstallmentSchema).min(1).max(60)
	}),
	z.object({
		type: z.literal("addExpense"),
		expense: OperatingExpenseSchema
	}),
	z.object({
		type: z.literal("payExpense"),
		expenseId: z.uuid(),
		paidOn: z.iso.date()
	}),
	z.object({
		type: z.literal("saveGoal"),
		goal: GoalSchema
	})
]);
/** Conversa com o assistente: a última mensagem é a pergunta. */
const AssistantMessageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.string().trim().min(1).max(4e3)
});
const AssistantRequestSchema = z.object({ messages: z.array(AssistantMessageSchema).min(1).max(20).refine((messages) => messages.at(-1)?.role === "user", "A última mensagem precisa ser a pergunta.") });
const digits = (size) => z.string().regex(new RegExp("^\\d{" + size + "}$"));
const FiscalSettingsSchema = z.object({
	cnpj: digits(14),
	stateRegistration: z.string().trim().max(20),
	taxRegime: z.union([
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4)
	]),
	uf: z.string().regex(/^[A-Z]{2}$/),
	operationNature: z.string().trim().min(2).max(60),
	cfopInternal: digits(4),
	cfopExternal: digits(4),
	defaultNcm: digits(8),
	icmsSituation: z.string().regex(/^\d{2,3}$/),
	pisSituation: digits(2),
	cofinsSituation: digits(2),
	environment: z.enum(["homologacao", "producao"]),
	city: z.string().trim().max(60).default(""),
	municipalRegistration: z.string().trim().max(15).default(""),
	serviceCode: z.string().regex(/^(\d{6})?$/).default("")
});
const NfeRecipientSchema = z.object({
	name: z.string().trim().min(2).max(60),
	document: z.string().regex(/^(\d{11}|\d{14})$/, "Informe o CPF (11 números) ou o CNPJ (14 números)."),
	stateRegistration: z.string().trim().max(20),
	street: z.string().trim().min(2).max(60),
	number: z.string().trim().min(1).max(60),
	district: z.string().trim().min(2).max(60),
	city: z.string().trim().min(2).max(60),
	uf: z.string().regex(/^[A-Z]{2}$/),
	zip: digits(8),
	email: z.string().trim().max(60),
	phone: z.string().regex(/^\d{0,14}$/)
});
const NfePaymentSchema = z.enum([
	"Pix",
	"Dinheiro",
	"Cartão de crédito",
	"Cartão de débito",
	"Transferência",
	"Boleto"
]);
const NfeRequestSchema = z.object({
	quoteId: z.uuid(),
	recipient: NfeRecipientSchema,
	payment: NfePaymentSchema
});
const NfseRequestSchema = z.object({
	quoteId: z.uuid(),
	recipient: NfeRecipientSchema,
	description: z.string().trim().min(2).max(1e3)
});
/** Cancelamento de NF-e ou NFS-e autorizada: o motivo vai para a SEFAZ ou a prefeitura (15 a 255 caracteres). */
const FiscalCancelSchema = z.object({ reason: z.string().trim().min(15, "Escreva o motivo com pelo menos 15 caracteres.").max(255) });
/** Carta de correção da NF-e autorizada (15 a 1000 caracteres); a última carta vale sozinha. */
const FiscalCorrectionRequestSchema = z.object({ text: z.string().trim().min(15, "Escreva a correção com pelo menos 15 caracteres.").max(1e3) });
const FiscalCorrectionSchema = z.object({
	sequence: z.number().int(),
	text: z.string(),
	pdfUrl: z.string().nullable(),
	xmlUrl: z.string().nullable(),
	createdAt: z.string()
});
const FiscalDocumentSchema = z.object({
	id: z.uuid(),
	kind: z.enum(["nfe", "nfse"]).default("nfe"),
	quoteId: z.uuid(),
	reference: z.string(),
	environment: FiscalSettingsSchema.shape.environment,
	status: z.string(),
	number: z.string().nullable(),
	series: z.string().nullable(),
	accessKey: z.string().nullable(),
	danfeUrl: z.string().nullable(),
	xmlUrl: z.string().nullable(),
	message: z.string().nullable(),
	recipient: NfeRecipientSchema,
	totalCents: MoneyCentsSchema,
	createdAt: z.string(),
	cancelReason: z.string().nullable().default(null),
	cancelXmlUrl: z.string().nullable().default(null),
	corrections: z.array(FiscalCorrectionSchema).default([])
});
z.object({
	available: z.object({
		homologacao: z.boolean(),
		producao: z.boolean()
	}),
	settings: FiscalSettingsSchema.nullable(),
	documents: z.array(FiscalDocumentSchema)
});
// ../../packages/contracts/dist/index.js
const ProjectStageSchema = z.enum([
	"quotation",
	"purchasing",
	"production",
	"installation",
	"delivered",
	"cancelled"
]);
const RoleSchema = z.enum([
	"admin",
	"manager",
	"sales",
	"production",
	"finance",
	"viewer"
]);
const CompanySchema = z.object({
	id: z.uuid(),
	name: z.string(),
	role: RoleSchema
});
const CreateProjectSchema = z.object({
	title: z.string().trim().min(2).max(120),
	customerName: z.string().trim().min(2).max(160),
	customerId: z.uuid().nullable().default(null),
	totalCents: PositiveMoneySchema,
	plannedCostCents: MoneyCentsSchema,
	dueDate: z.iso.date(),
	notes: z.string().trim().max(2e3).default("")
}).strict();
const ProjectSchema = CreateProjectSchema.extend({
	id: z.uuid(),
	companyId: z.uuid(),
	stage: ProjectStageSchema,
	receivedCents: MoneyCentsSchema,
	version: z.number().int().positive(),
	createdAt: z.iso.datetime()
});
const PaymentCommandSchema = z.object({
	amountCents: PositiveMoneySchema,
	expectedVersion: z.number().int().positive()
}).strict();
z.object({
	paymentId: z.uuid(),
	projectId: z.uuid(),
	amountCents: PositiveMoneySchema,
	balanceCents: MoneyCentsSchema,
	version: z.number().int().positive()
});
z.object({
	items: z.array(ProjectSchema),
	nextCursor: z.string().nullable()
});
const IdempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9._:-]{8,128}$/);
const AdvanceCommandSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const openApi = {
	openapi: "3.1.0",
	info: {
		title: "PraiaMar API",
		version: "0.1.0"
	},
	servers: [{ url: "http://127.0.0.1:3333" }],
	components: { securitySchemes: { oidc: {
		type: "http",
		scheme: "bearer",
		bearerFormat: "JWT"
	} } },
	paths: {
		"/health/live": { get: {
			summary: "Processo ativo",
			responses: { "200": { description: "Processo ativo" } }
		} },
		"/health/ready": { get: {
			summary: "Conexão de banco pronta",
			responses: {
				"200": { description: "Pronto" },
				"503": { description: "Banco indisponível" }
			}
		} },
		"/v1/projects": {
			get: {
				summary: "Projetos com paginação por cursor",
				security: [{ oidc: [] }],
				parameters: [
					{
						in: "header",
						name: "x-company-id",
						required: true,
						schema: {
							type: "string",
							format: "uuid"
						}
					},
					{
						in: "query",
						name: "limit",
						schema: {
							type: "integer",
							minimum: 1,
							maximum: 100
						}
					},
					{
						in: "query",
						name: "cursor",
						schema: { type: "string" }
					}
				],
				responses: {
					"200": { description: "Página de projetos" },
					"401": { description: "Não autenticado" },
					"403": { description: "Sem vínculo com a empresa" }
				}
			},
			post: {
				summary: "Cadastrar projeto",
				security: [{ oidc: [] }],
				parameters: [{
					in: "header",
					name: "x-company-id",
					required: true,
					schema: {
						type: "string",
						format: "uuid"
					}
				}, {
					in: "header",
					name: "idempotency-key",
					required: true,
					schema: { type: "string" }
				}],
				requestBody: {
					required: true,
					content: { "application/json": { schema: z.toJSONSchema(CreateProjectSchema) } }
				},
				responses: { "201": { description: "Projeto criado ou resposta idempotente" } }
			}
		},
		"/v1/projects/{id}/payments": { post: {
			summary: "Registrar recebimento transacional",
			security: [{ oidc: [] }],
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: {
						type: "string",
						format: "uuid"
					}
				},
				{
					in: "header",
					name: "x-company-id",
					required: true,
					schema: {
						type: "string",
						format: "uuid"
					}
				},
				{
					in: "header",
					name: "idempotency-key",
					required: true,
					schema: { type: "string" }
				}
			],
			requestBody: {
				required: true,
				content: { "application/json": { schema: z.toJSONSchema(PaymentCommandSchema) } }
			},
			responses: {
				"201": { description: "Recebimento registrado" },
				"409": { description: "Conflito de versão, saldo ou chave idempotente" }
			}
		} },
		"/v1/projects/{id}/advance": { post: {
			summary: "Avançar etapa após conferências",
			security: [{ oidc: [] }],
			parameters: [{
				in: "path",
				name: "id",
				required: true,
				schema: {
					type: "string",
					format: "uuid"
				}
			}, {
				in: "header",
				name: "x-company-id",
				required: true,
				schema: {
					type: "string",
					format: "uuid"
				}
			}],
			requestBody: {
				required: true,
				content: { "application/json": { schema: z.toJSONSchema(AdvanceCommandSchema) } }
			},
			responses: {
				"200": { description: "Projeto atualizado" },
				"409": { description: "Versão ou conferências pendentes" }
			}
		} }
	}
};
// ../../packages/domain/dist/errors.js
var AppError = class extends Error {
	code;
	status;
	constructor(code, message, status = 409) {
		super(message);
		this.code = code;
		this.status = status;
		this.name = "AppError";
	}
};
// ../../packages/domain/dist/commercial.js
const LIMIT = 9000000000000000n;
const sum = (values) => values.reduce((total, value) => total + BigInt(value), 0n);
const cents = (value) => {
	if (value < 0n || value > LIMIT) throw new AppError("VALUE_LIMIT", "O valor está fora do limite permitido.", 400);
	return value.toString();
};
const copyQuote = (quote) => ({
	...quote,
	items: quote.items.map((item) => ({ ...item }))
});
function formatQuantity(value) {
	const n = BigInt(value);
	const sign = n < 0n ? "-" : "";
	const absolute = n < 0n ? -n : n;
	const fraction = (absolute % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
	return sign + new Intl.NumberFormat("pt-BR").format(absolute / 1000n) + (fraction ? "," + fraction : "");
}
function lineValue(unitCents, quantityMilli) {
	return cents((BigInt(unitCents) * BigInt(quantityMilli) + 500n) / 1000n);
}
function marginBasisPoints(revenue, cost) {
	return BigInt(revenue) > 0n ? Number((BigInt(revenue) - BigInt(cost)) * 10000n / BigInt(revenue)) : 0;
}
function quoteTotals(quote) {
	const subtotal = sum(quote.items.map((item) => lineValue(item.unitPriceCents, item.quantityMilli)));
	const itemCost = sum(quote.items.map((item) => lineValue(item.unitCostCents, item.quantityMilli)));
	if (BigInt(quote.discountCents) > subtotal) throw new AppError("DISCOUNT", "O desconto não pode superar o total dos itens.", 400);
	const total = subtotal - BigInt(quote.discountCents) + BigInt(quote.shippingCents);
	const cost = itemCost + BigInt(quote.shippingCostCents);
	return {
		subtotalCents: cents(subtotal),
		costCents: cents(cost),
		totalCents: cents(total),
		grossProfitCents: (total - cost).toString(),
		marginBasisPoints: marginBasisPoints(total.toString(), cost.toString())
	};
}
/** Largest remainders keep distributed discounts equal to the original cent amount. */
function allocateCents(total, weights) {
	const amount = BigInt(total), weight = sum(weights);
	if (amount < 0n || weights.some((value) => BigInt(value) < 0n)) throw new AppError("ALLOCATION", "Rateio inválido.");
	if (weight === 0n) {
		if (amount !== 0n) throw new AppError("ALLOCATION", "Não há base para rateio.");
		return weights.map(() => "0");
	}
	const rows = weights.map((value, index) => ({
		index,
		value: amount * BigInt(value) / weight,
		remainder: amount * BigInt(value) % weight
	}));
	let missing = amount - rows.reduce((result, row) => result + row.value, 0n);
	const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
	for (const row of ranked) {
		if (missing === 0n) break;
		row.value++;
		missing--;
	}
	return rows.map((row) => row.value.toString());
}
function stockMilli(state, productId) {
	const product = state.products.find((item) => item.id === productId);
	if (!product) throw new AppError("NOT_FOUND", "Produto não encontrado.", 404);
	return (BigInt(product.openingStockMilli) + sum(state.inventory.filter((item) => item.productId === productId).map((item) => item.deltaMilli))).toString();
}
function saveCatalogItem(state, input) {
	const item = CatalogItemSchema.parse(input);
	const previous = state.products.find((product) => product.id === item.id);
	if (state.products.some((product) => product.id !== item.id && product.sku.toLowerCase() === item.sku.toLowerCase())) throw new AppError("DUPLICATE_SKU", "Esse código já está cadastrado.", 400);
	if (previous && previous.openingStockMilli !== item.openingStockMilli) throw new AppError("STOCK", "Use uma movimentação para alterar o estoque.");
	if (previous && previous.kind !== item.kind) throw new AppError("KIND", "O tipo de um cadastro existente não pode ser trocado.");
	if (previous && previous.unit !== item.unit) throw new AppError("UNIT", "Crie um novo cadastro para outra unidade de medida.");
	if (item.maxStockMilli && BigInt(item.maxStockMilli) < BigInt(item.minStockMilli)) throw new AppError("STOCK", "O estoque máximo fica abaixo do mínimo.", 400);
	return {
		...state,
		products: previous ? state.products.map((product) => product.id === item.id ? item : product) : [item, ...state.products]
	};
}
function moveInventory(state, input) {
	const movement = InventoryMovementSchema.parse(input);
	const product = state.products.find((item) => item.id === movement.productId);
	if (!product || product.kind === "service") throw new AppError("STOCK", "Selecione um produto ou material.");
	if (state.inventory.some((item) => item.id === movement.id)) return state;
	const stock = BigInt(stockMilli(state, product.id)), delta = BigInt(movement.deltaMilli);
	if (stock + delta < 0n) throw new AppError("STOCK", "A saída supera o estoque disponível.");
	if (movement.unitCostCents !== void 0 && delta < 0n) throw new AppError("STOCK", "Custo e fornecedor são da entrada de estoque.", 400);
	let costCents = product.costCents;
	if (movement.unitCostCents !== void 0) {
		const before = stock > 0n ? stock : 0n, total = before * BigInt(product.costCents) + delta * BigInt(movement.unitCostCents), units = before + delta;
		costCents = ((total * 2n + units) / (units * 2n)).toString();
	}
	return {
		...state,
		inventory: [movement, ...state.inventory],
		products: costCents === product.costCents ? state.products : state.products.map((item) => item.id === product.id ? {
			...item,
			costCents
		} : item)
	};
}
function saveQuote(state, input, eventId) {
	const quote = QuoteSchema.parse(input);
	const previous = state.quotes.find((item) => item.id === quote.id);
	if (state.quotes.some((item) => item.id !== quote.id && item.code === quote.code)) throw new AppError("CODE", "Esse número de orçamento já está em uso.");
	if (previous?.status === "approved" || quote.status === "approved") throw new AppError("APPROVED_LOCK", "A proposta aprovada fica preservada. Duplique para uma nova negociação.");
	if (previous && previous.revision !== quote.revision) throw new AppError("VERSION_CONFLICT", "O orçamento mudou. Abra novamente antes de salvar.");
	if (quote.validUntil < quote.createdOn || quote.dueDate < quote.createdOn) throw new AppError("DATE", "Validade e prazo não podem ser anteriores à criação.", 400);
	if (quoteTotals(quote).totalCents === "0") throw new AppError("TOTAL", "O orçamento precisa ter um valor de venda positivo.", 400);
	const saved = {
		...quote,
		revision: previous ? previous.revision + 1 : 1,
		approvedOn: null
	};
	return {
		...state,
		quotes: previous ? state.quotes.map((item) => item.id === saved.id ? saved : item) : [saved, ...state.quotes],
		versions: [{
			id: eventId,
			quoteId: saved.id,
			revision: saved.revision,
			snapshot: copyQuote(saved),
			reason: previous ? "Edição comercial" : "Criação",
			createdOn: state.referenceDate
		}, ...state.versions]
	};
}
function approveQuote(state, quoteId, revision, projectId, eventId) {
	const quote = state.quotes.find((item) => item.id === quoteId);
	if (!quote) throw new AppError("NOT_FOUND", "Orçamento não encontrado.", 404);
	if (quote.status === "approved" && state.projects.some((project) => project.quoteId === quoteId)) return state;
	if (quote.revision !== revision) throw new AppError("VERSION_CONFLICT", "O orçamento mudou. Confira a revisão.");
	const approved = {
		...quote,
		status: "approved",
		approvedOn: state.referenceDate
	};
	return {
		...state,
		quotes: state.quotes.map((item) => item.id === quoteId ? approved : item),
		projects: [{
			id: projectId,
			quoteId,
			stage: "purchasing",
			version: 1,
			dueDate: quote.dueDate,
			createdOn: state.referenceDate
		}, ...state.projects],
		versions: [{
			id: eventId,
			quoteId,
			revision,
			snapshot: copyQuote(approved),
			reason: "Aprovação e criação de projeto",
			createdOn: state.referenceDate
		}, ...state.versions]
	};
}
function receivedForProject(state, projectId) {
	return sum(state.payments.filter((payment) => payment.projectId === projectId).map((payment) => payment.amountCents)).toString();
}
function projectBalance(state, projectId) {
	const project = state.projects.find((item) => item.id === projectId);
	const quote = state.quotes.find((item) => item.id === project?.quoteId);
	if (!project || !quote) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
	return (BigInt(quoteTotals(quote).totalCents) - BigInt(receivedForProject(state, projectId))).toString();
}
function addCommercialPayment(state, input, expectedVersion) {
	const payment = CommercialPaymentSchema.parse(input);
	const existing = state.payments.find((item) => item.commandId === payment.commandId);
	if (existing) {
		if (existing.projectId !== payment.projectId || existing.amountCents !== payment.amountCents || existing.receivedOn !== payment.receivedOn || existing.method !== payment.method) throw new AppError("IDEMPOTENCY", "A confirmação já foi usada com outro conteúdo.");
		return state;
	}
	const project = state.projects.find((item) => item.id === payment.projectId);
	if (!project || project.stage === "cancelled") throw new AppError("PROJECT", "O projeto não permite recebimento.");
	if (project.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "O projeto mudou. Atualize antes de confirmar.");
	if (BigInt(payment.amountCents) > BigInt(projectBalance(state, project.id))) throw new AppError("INSUFFICIENT_BALANCE", "O recebimento supera o saldo do projeto.");
	if (payment.receivedOn > state.referenceDate) throw new AppError("DATE", "A data do recebimento não pode estar no futuro.", 400);
	return {
		...state,
		payments: [payment, ...state.payments],
		projects: state.projects.map((item) => item.id === project.id ? {
			...item,
			version: item.version + 1
		} : item)
	};
}
/** Muda a etapa do projeto; a mesma etapa não muda nada. Com dinheiro recebido não cancela (falta o estorno). */
function moveProjectStage(state, projectId, stage, expectedVersion) {
	const project = state.projects.find((item) => item.id === projectId);
	if (!project) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
	if (project.stage === stage) return state;
	if (project.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "O projeto mudou. Atualize antes de mover.");
	if (stage === "cancelled" && BigInt(receivedForProject(state, projectId)) > 0n) throw new AppError("PROJECT", "O projeto já tem recebimento e não pode ser cancelado.");
	return {
		...state,
		projects: state.projects.map((item) => item.id === projectId ? {
			...item,
			stage,
			version: item.version + 1
		} : item)
	};
}
/** Troca o plano de parcelas do projeto: soma igual ao contrato, datas e ids próprios; os recebimentos não mudam. */
function planInstallments(state, projectId, input) {
	const installments = input.map((item) => InstallmentSchema.parse(item));
	const project = state.projects.find((item) => item.id === projectId);
	const quote = state.quotes.find((item) => item.id === project?.quoteId);
	if (!project || !quote) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
	if (project.stage === "cancelled") throw new AppError("PROJECT", "Projeto cancelado não tem parcelas.");
	if (!installments.length || installments.length > 60) throw new AppError("INSTALLMENTS", "Use de 1 a 60 parcelas.", 400);
	if (installments.some((item) => item.projectId !== projectId)) throw new AppError("INSTALLMENTS", "As parcelas são de outro projeto.", 400);
	if (new Set(installments.map((item) => item.id)).size !== installments.length) throw new AppError("INSTALLMENTS", "Parcela repetida.", 400);
	if (sum(installments.map((item) => item.amountCents)) !== BigInt(quoteTotals(quote).totalCents)) throw new AppError("INSTALLMENTS", "As parcelas precisam somar o valor do contrato.", 400);
	return {
		...state,
		installments: [...state.installments.filter((item) => item.projectId !== projectId), ...installments]
	};
}
function addOperatingExpense(state, input) {
	const expense = OperatingExpenseSchema.parse(input);
	if (expense.quoteId && !state.quotes.some((quote) => quote.id === expense.quoteId && quote.status === "approved")) throw new AppError("EXPENSE", "Vincule a despesa a um contrato aprovado ou à empresa.");
	if (state.expenses.some((item) => item.id === expense.id)) return state;
	return {
		...state,
		expenses: [expense, ...state.expenses]
	};
}
/** Marca a despesa como paga na data informada; já paga, fica como está. */
function payOperatingExpense(state, expenseId, paidOn) {
	const expense = state.expenses.find((item) => item.id === expenseId);
	if (!expense) throw new AppError("NOT_FOUND", "Despesa não encontrada.", 404);
	if (expense.paidOn) return state;
	if (paidOn > state.referenceDate) throw new AppError("DATE", "A data do pagamento não pode estar no futuro.", 400);
	return {
		...state,
		expenses: state.expenses.map((item) => item.id === expenseId ? {
			...item,
			paidOn
		} : item)
	};
}
function saveGoal(state, input) {
	const goal = GoalSchema.parse(input);
	if (goal.end < goal.start) throw new AppError("PERIOD", "O fim da meta vem antes do início.", 400);
	return {
		...state,
		goals: [goal, ...state.goals.filter((item) => !(item.start === goal.start && item.end === goal.end && item.owner === goal.owner))]
	};
}
/** Ponto único das alterações: a tela (na hora) e a API (na transação) aplicam o mesmo comando. */
function applyCommercialCommand(state, command) {
	switch (command.type) {
		case "saveCatalogItem": return saveCatalogItem(state, command.item);
		case "moveInventory": return moveInventory(state, command.movement);
		case "saveQuote": return saveQuote(state, command.quote, command.eventId);
		case "approveQuote": return approveQuote(state, command.quoteId, command.revision, command.projectId, command.eventId);
		case "addPayment": return addCommercialPayment(state, command.payment, command.expectedVersion);
		case "moveProject": return moveProjectStage(state, command.projectId, command.stage, command.expectedVersion);
		case "planInstallments": return planInstallments(state, command.projectId, command.installments);
		case "addExpense": return addOperatingExpense(state, command.expense);
		case "payExpense": return payOperatingExpense(state, command.expenseId, command.paidOn);
		case "saveGoal": return saveGoal(state, command.goal);
	}
}
const day = (value) => /* @__PURE__ */ new Date(value + "T00:00:00Z");
const iso = (value) => value.toISOString().slice(0, 10);
const between = (value, start, end) => value !== null && value >= start && value <= end;
function validateAnalyticsFilter(input) {
	const filter = AnalyticsFilterSchema.parse(input);
	const days = (day(filter.end).getTime() - day(filter.start).getTime()) / 864e5;
	if (days < 0 || days > 731) throw new AppError("PERIOD", "Escolha um período válido de até dois anos.", 400);
	return filter;
}
function previousPeriod(input) {
	const filter = validateAnalyticsFilter(input);
	const start = day(filter.start), end = day(filter.end);
	const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));
	if (start.getUTCDate() === 1 && end.getUTCDate() === last.getUTCDate()) {
		const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1;
		return {
			...filter,
			start: iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months, 1))),
			end: iso(/* @__PURE__ */ new Date(start.getTime() - 864e5)),
			compare: false
		};
	}
	const span = end.getTime() - start.getTime() + 864e5;
	return {
		...filter,
		start: iso(new Date(start.getTime() - span)),
		end: iso(/* @__PURE__ */ new Date(start.getTime() - 864e5)),
		compare: false
	};
}
function effectiveQuoteStatus(quote, reference) {
	return quote.status === "sent" && quote.validUntil < reference ? "expired" : quote.status;
}
function approvedInPeriod(state, input) {
	const filter = validateAnalyticsFilter(input);
	return state.quotes.filter((quote) => quote.status === "approved" && between(quote.approvedOn, filter.start, filter.end) && (filter.owner === "all" || quote.owner === filter.owner));
}
function analyticsSlice(state, filter) {
	const approved = approvedInPeriod(state, filter);
	const visibleOwner = (quoteId) => filter.owner === "all" || quoteId !== null && state.quotes.some((quote) => quote.id === quoteId && quote.owner === filter.owner);
	const expenses = state.expenses.filter((expense) => between(expense.incurredOn, filter.start, filter.end) && visibleOwner(expense.quoteId));
	const payments = state.payments.filter((payment) => between(payment.receivedOn, filter.start, filter.end) && visibleOwner(state.projects.find((project) => project.id === payment.projectId)?.quoteId ?? null));
	const paidExpenses = state.expenses.filter((expense) => between(expense.paidOn, filter.start, filter.end) && visibleOwner(expense.quoteId));
	const sales = sum(approved.map((quote) => quoteTotals(quote).totalCents)), cost = sum(approved.map((quote) => quoteTotals(quote).costCents));
	const expense = sum(expenses.map((item) => item.amountCents)), cashIn = sum(payments.map((item) => item.amountCents)), cashOut = sum(paidExpenses.map((item) => item.amountCents));
	const cohort = state.quotes.filter((quote) => between(quote.createdOn, filter.start, filter.end) && (filter.owner === "all" || quote.owner === filter.owner));
	const eligible = cohort.filter((quote) => quote.status !== "draft");
	const won = eligible.filter((quote) => quote.status === "approved");
	const approvedIds = new Set(approved.map((quote) => quote.id));
	const receivedCohort = sum(state.payments.filter((payment) => approvedIds.has(state.projects.find((project) => project.id === payment.projectId)?.quoteId ?? "") && payment.receivedOn <= state.referenceDate).map((payment) => payment.amountCents));
	return {
		approved,
		expenses,
		payments,
		cohort,
		salesCents: sales.toString(),
		costCents: cost.toString(),
		expenseCents: expense.toString(),
		grossProfitCents: (sales - cost).toString(),
		resultCents: (sales - cost - expense).toString(),
		marginBasisPoints: marginBasisPoints(sales.toString(), cost.toString()),
		cashInCents: cashIn.toString(),
		cashOutCents: cashOut.toString(),
		cashBalanceCents: (cashIn - cashOut).toString(),
		receivedCohortCents: receivedCohort.toString(),
		outstandingCohortCents: (sales - receivedCohort).toString(),
		conversionBasisPoints: eligible.length ? Math.round(won.length * 1e4 / eligible.length) : 0,
		eligible: eligible.length,
		won: won.length
	};
}
function calculateAnalytics(state, input) {
	const filter = validateAnalyticsFilter(input), current = analyticsSlice(state, filter);
	const comparison = filter.compare ? analyticsSlice(state, previousPeriod(filter)) : null;
	const cursor = day(filter.start);
	cursor.setUTCDate(1);
	const end = day(filter.end);
	const series = [];
	while (cursor <= end) {
		const key = iso(cursor).slice(0, 7), start = key + "-01", last = iso(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)));
		const monthly = analyticsSlice(state, {
			...filter,
			start: start < filter.start ? filter.start : start,
			end: last > filter.end ? filter.end : last,
			compare: false
		});
		series.push({
			key,
			label: new Intl.DateTimeFormat("pt-BR", {
				month: "short",
				timeZone: "UTC"
			}).format(cursor).replace(".", "") + "/" + String(cursor.getUTCFullYear()).slice(-2),
			salesCents: monthly.salesCents,
			costCents: monthly.costCents,
			resultCents: monthly.resultCents,
			cashInCents: monthly.cashInCents,
			cashOutCents: monthly.cashOutCents
		});
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}
	const products = /* @__PURE__ */ new Map();
	for (const quote of current.approved) {
		const values = quote.items.map((item) => lineValue(item.unitPriceCents, item.quantityMilli));
		const discounts = allocateCents(quote.discountCents, values);
		quote.items.forEach((item, index) => {
			const row = products.get(item.productId) ?? {
				id: item.productId,
				name: item.description,
				kind: item.kind,
				unit: item.unit,
				quantityMilli: 0n,
				revenue: 0n,
				cost: 0n,
				quoteIds: /* @__PURE__ */ new Set()
			};
			row.quantityMilli += BigInt(item.quantityMilli);
			row.revenue += BigInt(values[index] ?? "0") - BigInt(discounts[index] ?? "0");
			row.cost += BigInt(lineValue(item.unitCostCents, item.quantityMilli));
			row.quoteIds.add(quote.id);
			products.set(item.productId, row);
		});
	}
	const ranking = [...products.values()].sort((a, b) => a.revenue === b.revenue ? a.name.localeCompare(b.name) : a.revenue > b.revenue ? -1 : 1).map((item) => ({
		id: item.id,
		name: item.name,
		kind: item.kind,
		unit: item.unit,
		quantityMilli: item.quantityMilli.toString(),
		revenueCents: item.revenue.toString(),
		costCents: item.cost.toString(),
		marginBasisPoints: marginBasisPoints(item.revenue.toString(), item.cost.toString()),
		quoteIds: [...item.quoteIds]
	}));
	const goal = state.goals.find((item) => item.start === filter.start && item.end === filter.end && item.owner === filter.owner) ?? null;
	return {
		...current,
		comparison,
		series,
		ranking,
		goal,
		filter
	};
}
const nfeUnits = {
	un: "UN",
	m: "M",
	"m²": "M2",
	h: "H",
	chapa: "CHAPA"
};
const nfePayments = {
	Dinheiro: "01",
	"Cartão de crédito": "03",
	"Cartão de débito": "04",
	Boleto: "15",
	Pix: "17",
	Transferência: "18"
};
const reais = (cents) => {
	const value = BigInt(cents);
	return Number(`${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`);
};
const units3 = (milli) => Number(`${BigInt(milli) / 1000n}.${(BigInt(milli) % 1000n).toString().padStart(3, "0")}`);
/**
* NF-e (modelo 55) do orçamento aprovado, no formato do provedor (Focus NFe). Só produtos e materiais: serviço vai na
* nota de serviço (NFS-e). Desconto e frete do orçamento são rateados entre os itens pela regra dos centavos; o CFOP e
* o destino mudam quando o cliente é de outro estado.
*/
function buildNfe(state, quoteId, settings, recipient, payment, issuedAt) {
	const quote = state.quotes.find((item) => item.id === quoteId);
	if (!quote || quote.status !== "approved") throw new AppError("NFE_QUOTE", "A NF-e sai de um orçamento aprovado.", 400);
	const lines = quote.items.map((item) => lineValue(item.unitPriceCents, item.quantityMilli));
	const discounts = allocateCents(quote.discountCents, lines);
	const goods = quote.items.map((item, index) => ({
		item,
		gross: lines[index],
		discount: discounts[index]
	})).filter(({ item }) => item.kind !== "service");
	if (!goods.length) throw new AppError("NFE_ITEMS", "O orçamento só tem serviços: eles vão na nota de serviço (NFS-e), não na NF-e.", 400);
	const freights = allocateCents(quote.shippingCents, goods.map((good) => good.gross));
	const inside = recipient.uf === settings.uf;
	const cfop = inside ? settings.cfopInternal : settings.cfopExternal;
	const catalog = new Map(state.products.map((product) => [product.id, product]));
	const productsCents = sum(goods.map((good) => good.gross)), discountCents = sum(goods.map((good) => good.discount)), freightCents = sum(freights), totalCents = productsCents - discountCents + freightCents;
	const document = recipient.document.length === 11 ? { cpf_destinatario: recipient.document } : { cnpj_destinatario: recipient.document };
	return {
		totalCents: totalCents.toString(),
		payload: {
			natureza_operacao: settings.operationNature,
			data_emissao: issuedAt,
			tipo_documento: 1,
			finalidade_emissao: 1,
			cnpj_emitente: settings.cnpj,
			...settings.stateRegistration && { inscricao_estadual_emitente: settings.stateRegistration },
			regime_tributario_emitente: settings.taxRegime,
			nome_destinatario: recipient.name,
			...document,
			...recipient.stateRegistration && { inscricao_estadual_destinatario: recipient.stateRegistration },
			indicador_inscricao_estadual_destinatario: recipient.stateRegistration ? 1 : 9,
			logradouro_destinatario: recipient.street,
			numero_destinatario: recipient.number,
			bairro_destinatario: recipient.district,
			municipio_destinatario: recipient.city,
			uf_destinatario: recipient.uf,
			cep_destinatario: recipient.zip,
			pais_destinatario: "Brasil",
			...recipient.phone && { telefone_destinatario: recipient.phone },
			...recipient.email && { email_destinatario: recipient.email },
			presenca_comprador: 1,
			modalidade_frete: freightCents > 0n ? 0 : 9,
			local_destino: inside ? 1 : 2,
			consumidor_final: 1,
			valor_produtos: reais(productsCents),
			valor_desconto: reais(discountCents),
			valor_frete: reais(freightCents),
			valor_total: reais(totalCents),
			items: goods.map(({ item, gross, discount }, index) => {
				const unit = nfeUnits[item.unit] ?? "UN";
				return {
					numero_item: index + 1,
					codigo_produto: item.sku || "ITEM-" + (index + 1),
					descricao: item.description,
					cfop,
					codigo_ncm: catalog.get(item.productId)?.ncm ?? settings.defaultNcm,
					unidade_comercial: unit,
					quantidade_comercial: units3(item.quantityMilli),
					valor_unitario_comercial: reais(item.unitPriceCents),
					unidade_tributavel: unit,
					quantidade_tributavel: units3(item.quantityMilli),
					valor_unitario_tributavel: reais(item.unitPriceCents),
					valor_bruto: reais(gross),
					valor_desconto: reais(discount),
					valor_frete: reais(freights[index]),
					inclui_no_total: 1,
					icms_origem: 0,
					icms_situacao_tributaria: settings.icmsSituation,
					pis_situacao_tributaria: settings.pisSituation,
					cofins_situacao_tributaria: settings.cofinsSituation
				};
			}),
			formas_pagamento: [{
				forma_pagamento: nfePayments[payment],
				valor_pagamento: reais(totalCents)
			}]
		}
	};
}
const simplesOption = {
	1: 3,
	2: 3,
	3: 1,
	4: 2
};
/**
* NFS-e (padrão nacional, DPS) do orçamento aprovado, no formato do provedor (Focus NFe). Só os serviços, com o
* desconto rateado pela regra dos centavos. A prestação fica na cidade do cliente (montagem e instalação na obra); a
* alíquota do ISS vem do sistema nacional.
*/
function buildNfse(state, quoteId, settings, recipient, description, dps) {
	const quote = state.quotes.find((item) => item.id === quoteId);
	if (!quote || quote.status !== "approved") throw new AppError("NFE_QUOTE", "A nota sai de um orçamento aprovado.", 400);
	if (!dps.cityCode || !settings.serviceCode) throw new AppError("FISCAL_SETTINGS", "Preencha a cidade e o código do serviço nos dados fiscais.", 400);
	const lines = quote.items.map((item) => lineValue(item.unitPriceCents, item.quantityMilli));
	const discounts = allocateCents(quote.discountCents, lines);
	const services = quote.items.flatMap((item, index) => item.kind === "service" ? [{
		gross: lines[index],
		discount: discounts[index]
	}] : []);
	const grossCents = sum(services.map((item) => item.gross)), discountCents = sum(services.map((item) => item.discount)), totalCents = grossCents - discountCents;
	if (totalCents <= 0n) throw new AppError("NFSE_ITEMS", "O orçamento não tem serviços a cobrar: produtos vão na NF-e.", 400);
	const option = simplesOption[settings.taxRegime];
	return {
		totalCents: totalCents.toString(),
		payload: {
			data_emissao: dps.issuedAt,
			data_competencia: dps.date,
			serie_dps: 1,
			numero_dps: dps.number,
			emitente_dps: 1,
			codigo_municipio_emissora: Number(dps.cityCode),
			cnpj_prestador: settings.cnpj,
			...settings.municipalRegistration && { inscricao_municipal_prestador: settings.municipalRegistration },
			codigo_opcao_simples_nacional: option,
			...option === 3 && { regime_tributario_simples_nacional: 1 },
			regime_especial_tributacao: 0,
			...recipient.document.length === 11 ? { cpf_tomador: recipient.document } : { cnpj_tomador: recipient.document },
			razao_social_tomador: recipient.name,
			codigo_municipio_tomador: Number(dps.recipientCityCode),
			cep_tomador: recipient.zip,
			logradouro_tomador: recipient.street,
			numero_tomador: recipient.number,
			bairro_tomador: recipient.district,
			...recipient.phone && { telefone_tomador: recipient.phone },
			...recipient.email && { email_tomador: recipient.email },
			codigo_municipio_prestacao: dps.recipientCityCode,
			codigo_tributacao_nacional_iss: settings.serviceCode,
			descricao_servico: description,
			valor_servico: reais(grossCents),
			...discountCents > 0n && { desconto_incondicionado: reais(discountCents) },
			tributacao_iss: 1,
			tipo_retencao_iss: 1
		}
	};
}
// ../../packages/domain/dist/index.js
function formatMoney(cents) {
	const value = BigInt(cents);
	const absolute = value < 0n ? -value : value;
	return `${value < 0n ? "- " : ""}R$ ${new Intl.NumberFormat("pt-BR").format(absolute / 100n)},${(absolute % 100n).toString().padStart(2, "0")}`;
}
function outstanding(total, receipts, reversed = "0") {
	const result = BigInt(total) - BigInt(receipts) + BigInt(reversed);
	if (result < 0n) throw new AppError("BALANCE_INVALID", "Os recebimentos ultrapassam o valor do contrato.");
	return result.toString();
}
function validateReceipt(total, received, amount) {
	if (BigInt(amount) <= 0n) throw new AppError("VALIDATION", "O recebimento deve ser positivo.", 400);
	const balance = BigInt(outstanding(total, received));
	if (BigInt(amount) > balance) throw new AppError("INSUFFICIENT_BALANCE", "O recebimento supera o saldo do projeto.");
	return (balance - BigInt(amount)).toString();
}
function nextStage(current, context) {
	const stages = [
		"quotation",
		"purchasing",
		"production",
		"installation",
		"delivered"
	];
	const index = stages.indexOf(current);
	const next = stages[index + 1];
	if (index < 0 || !next) throw new AppError("STAGE_BLOCKED", "Este projeto não tem uma próxima etapa.");
	if (current === "quotation" && BigInt(context.plannedCostCents) <= 0n) throw new AppError("STAGE_BLOCKED", "Informe o custo previsto antes da aprovação.");
	if (["production", "installation"].includes(next) && context.pendingMaterials) throw new AppError("STAGE_BLOCKED", "Confira os materiais pendentes antes de avançar.");
	if (next === "delivered" && context.incompleteTasks > 0) throw new AppError("STAGE_BLOCKED", "Conclua o checklist antes de registrar a entrega.");
	return next;
}
// dist/commercial.js
const zone = "America/Sao_Paulo";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(/* @__PURE__ */ new Date());
const noon = (date) => date + "T12:00:00-03:00";
const localDate = (column) => `(${column} at time zone '${zone}')::date::text`;
async function loadState(sql, companyId, referenceDate) {
	const rows = (text) => sql.query(text, [companyId]);
	const [products, quotes, items, projects, payments, expenses, inventory, versions, goals, installments] = await Promise.all([
		rows(`select id,sku,name,kind,category,unit,cost_cents::text as cost,price_cents::text as price,(opening_stock*1000)::bigint::text as opening,(minimum_stock*1000)::bigint::text as minimum,(maximum_stock*1000)::bigint::text as maximum,active,ncm from catalog_items where company_id=$1 order by created_at desc,id`),
		rows(`select id,code,title,customer_name,responsible_label,created_on::text,valid_until::text,due_date::text,status,approved_on::text,revision,discount_cents::text as discount,shipping_cents::text as shipping,shipping_cost_cents::text as shipping_cost,notes from commercial_quotes where company_id=$1 order by created_on desc,created_at desc,id`),
		rows(`select quote_id,id,product_id,sku_snapshot,description_snapshot,kind_snapshot,category_snapshot,unit_snapshot,(quantity*1000)::bigint::text as quantity,unit_price_cents::text as price,unit_cost_cents::text as cost from commercial_quote_items where company_id=$1 order by quote_id,position`),
		rows(`select id,source_quote_id,stage,version,due_date::text,${localDate("created_at")} as created_on from projects where company_id=$1 and source_quote_id is not null order by created_at desc,id`),
		rows(`select id,command_id,project_id,amount_cents::text as amount,received_on::text,method from payments where company_id=$1 and command_id is not null order by received_on desc,created_at desc,id`),
		rows(`select id,description,category,quote_id,amount_cents::text as amount,incurred_on::text,paid_on::text from operating_expenses where company_id=$1 order by incurred_on desc,created_at desc,id`),
		rows(`select id,product_id,(delta*1000)::bigint::text as delta,reason,occurred_on::text,supplier,unit_cost_cents::text as unit_cost from inventory_movements where company_id=$1 order by occurred_on desc,created_at desc,id`),
		rows(`select id,quote_id,revision,event,snapshot,${localDate("created_at")} as created_on from commercial_quote_revisions where company_id=$1 order by created_at desc,revision desc,id`),
		rows(`select period_start::text,period_end::text,responsible_label,revenue_target_cents::text as target,(margin_target*100)::int as margin from company_goals where company_id=$1 order by period_start desc,period_end desc,responsible_label`),
		rows(`select id,project_id,due_on::text,amount_cents::text as amount from project_installments where company_id=$1 order by project_id,due_on,id`)
	]);
	return DemoCommercialStateSchema.parse({
		schemaVersion: 2,
		referenceDate,
		products: products.map((row) => ({
			id: row.id,
			sku: row.sku,
			name: row.name,
			kind: row.kind,
			category: row.category,
			unit: row.unit,
			costCents: row.cost,
			priceCents: row.price,
			openingStockMilli: row.opening,
			minStockMilli: row.minimum,
			...row.maximum && { maxStockMilli: row.maximum },
			active: row.active,
			...row.ncm && { ncm: row.ncm }
		})),
		quotes: quotes.map((row) => ({
			id: row.id,
			code: row.code,
			title: row.title,
			customerName: row.customer_name,
			owner: row.responsible_label,
			createdOn: row.created_on,
			validUntil: row.valid_until,
			dueDate: row.due_date,
			status: row.status,
			approvedOn: row.approved_on,
			revision: row.revision,
			discountCents: row.discount,
			shippingCents: row.shipping,
			shippingCostCents: row.shipping_cost,
			notes: row.notes,
			items: items.filter((item) => item.quote_id === row.id).map((item) => ({
				id: item.id,
				productId: item.product_id ?? item.id,
				sku: item.sku_snapshot,
				description: item.description_snapshot,
				kind: item.kind_snapshot,
				category: item.category_snapshot,
				unit: item.unit_snapshot,
				quantityMilli: item.quantity,
				unitPriceCents: item.price,
				unitCostCents: item.cost
			}))
		})),
		projects: projects.map((row) => ({
			id: row.id,
			quoteId: row.source_quote_id,
			stage: row.stage,
			version: row.version,
			dueDate: row.due_date,
			createdOn: row.created_on
		})),
		payments: payments.map((row) => ({
			id: row.id,
			commandId: row.command_id,
			projectId: row.project_id,
			amountCents: row.amount,
			receivedOn: row.received_on,
			method: row.method
		})),
		installments: installments.map((row) => ({
			id: row.id,
			projectId: row.project_id,
			dueOn: row.due_on,
			amountCents: row.amount
		})),
		expenses: expenses.map((row) => ({
			id: row.id,
			description: row.description,
			category: row.category,
			quoteId: row.quote_id,
			amountCents: row.amount,
			incurredOn: row.incurred_on,
			paidOn: row.paid_on
		})),
		inventory: inventory.map((row) => ({
			id: row.id,
			productId: row.product_id,
			deltaMilli: row.delta,
			reason: row.reason,
			occurredOn: row.occurred_on,
			...row.supplier && { supplier: row.supplier },
			...row.unit_cost && { unitCostCents: row.unit_cost }
		})),
		versions: versions.map((row) => ({
			id: row.id,
			quoteId: row.quote_id,
			revision: row.revision,
			snapshot: row.snapshot,
			reason: row.event === "approved" ? "Aprovação e criação de projeto" : row.revision === 1 ? "Criação" : "Edição comercial",
			createdOn: row.created_on
		})),
		goals: goals.map((row) => ({
			start: row.period_start,
			end: row.period_end,
			owner: row.responsible_label,
			salesCents: row.target,
			marginBasisPoints: row.margin
		}))
	});
}
async function writeProduct(sql, scope, item) {
	await sql.query(`insert into catalog_items(id,company_id,sku,name,kind,category,unit,price_cents,cost_cents,opening_stock,minimum_stock,active,ncm,maximum_stock)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric/1000,$11::numeric/1000,$12,$13,$14::numeric/1000)
     on conflict (id) do update set sku=excluded.sku,name=excluded.name,category=excluded.category,price_cents=excluded.price_cents,
     cost_cents=excluded.cost_cents,minimum_stock=excluded.minimum_stock,active=excluded.active,ncm=excluded.ncm,
     maximum_stock=excluded.maximum_stock,version=catalog_items.version+1
     where catalog_items.company_id=excluded.company_id`, [
		item.id,
		scope.companyId,
		item.sku,
		item.name,
		item.kind,
		item.category,
		item.unit,
		item.priceCents,
		item.costCents,
		item.openingStockMilli,
		item.minStockMilli,
		item.active,
		item.ncm ?? null,
		item.maxStockMilli ?? null
	]);
}
async function writeQuote(sql, scope, quote, catalog) {
	await sql.query(`insert into commercial_quotes(id,company_id,code,customer_name,title,responsible_label,status,revision,created_on,valid_until,due_date,discount_cents,shipping_cents,shipping_cost_cents,notes)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (id) do update set code=excluded.code,customer_name=excluded.customer_name,title=excluded.title,
     responsible_label=excluded.responsible_label,status=excluded.status,revision=excluded.revision,created_on=excluded.created_on,
     valid_until=excluded.valid_until,due_date=excluded.due_date,discount_cents=excluded.discount_cents,
     shipping_cents=excluded.shipping_cents,shipping_cost_cents=excluded.shipping_cost_cents,notes=excluded.notes
     where commercial_quotes.company_id=excluded.company_id`, [
		quote.id,
		scope.companyId,
		quote.code,
		quote.customerName,
		quote.title,
		quote.owner,
		quote.status === "approved" ? "sent" : quote.status,
		quote.revision,
		quote.createdOn,
		quote.validUntil,
		quote.dueDate,
		quote.discountCents,
		quote.shippingCents,
		quote.shippingCostCents,
		quote.notes
	]);
	await sql.query("delete from commercial_quote_items where company_id=$1 and quote_id=$2", [scope.companyId, quote.id]);
	for (const [position, item] of quote.items.entries()) await sql.query(`insert into commercial_quote_items(id,company_id,quote_id,product_id,position,sku_snapshot,description_snapshot,kind_snapshot,category_snapshot,unit_snapshot,quantity,unit_price_cents,unit_cost_cents)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric/1000,$12,$13)`, [
		item.id,
		scope.companyId,
		quote.id,
		catalog.has(item.productId) ? item.productId : null,
		position,
		item.sku,
		item.description,
		item.kind,
		item.category,
		item.unit,
		item.quantityMilli,
		item.unitPriceCents,
		item.unitCostCents
	]);
	if (quote.status === "approved") await approve(sql, scope, quote);
}
const approve = (sql, scope, quote) => sql.query(`update commercial_quotes set status='approved',approved_on=$3 where company_id=$1 and id=$2`, [
	scope.companyId,
	quote.id,
	quote.approvedOn
]);
async function writeVersion(sql, scope, version) {
	await sql.query(`insert into commercial_quote_revisions(id,company_id,quote_id,revision,event,snapshot,actor_id,created_at)
     values($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::timestamptz) on conflict do nothing`, [
		version.id,
		scope.companyId,
		version.quoteId,
		version.revision,
		version.reason.startsWith("Aprova") ? "approved" : "saved",
		JSON.stringify(version.snapshot),
		scope.userId,
		noon(version.createdOn)
	]);
}
async function writeProject(sql, scope, project, quote) {
	const totals = quoteTotals(quote);
	await sql.query(`insert into projects(id,company_id,customer_name,title,stage,total_cents,planned_cost_cents,due_date,approved_at,source_quote_id,version,created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::timestamptz,$12::timestamptz)`, [
		project.id,
		scope.companyId,
		quote.customerName,
		quote.title,
		project.stage,
		totals.totalCents,
		totals.costCents,
		project.dueDate,
		noon(quote.approvedOn ?? project.createdOn),
		quote.id,
		project.version,
		noon(project.createdOn)
	]);
}
async function writePayment(sql, scope, payment) {
	await sql.query(`insert into payments(id,company_id,project_id,amount_cents,received_at,received_on,method,command_id,created_by)
     values($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9) on conflict do nothing`, [
		payment.id,
		scope.companyId,
		payment.projectId,
		payment.amountCents,
		noon(payment.receivedOn),
		payment.receivedOn,
		payment.method,
		payment.commandId,
		scope.userId
	]);
}
async function writeExpense(sql, scope, expense) {
	await sql.query(`insert into operating_expenses(id,company_id,quote_id,description,category,amount_cents,incurred_on,paid_on,actor_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`, [
		expense.id,
		scope.companyId,
		expense.quoteId,
		expense.description,
		expense.category,
		expense.amountCents,
		expense.incurredOn,
		expense.paidOn,
		scope.userId
	]);
}
async function writeMovement(sql, scope, movement) {
	await sql.query(`insert into inventory_movements(id,company_id,product_id,delta,reason,occurred_on,actor_id,supplier,unit_cost_cents)
     values($1,$2,$3,$4::numeric/1000,$5,$6,$7,$8,$9) on conflict (id) do nothing`, [
		movement.id,
		scope.companyId,
		movement.productId,
		movement.deltaMilli,
		movement.reason,
		movement.occurredOn,
		scope.userId,
		movement.supplier ?? null,
		movement.unitCostCents ?? null
	]);
}
async function writeGoal(sql, scope, goal) {
	await sql.query(`insert into company_goals(company_id,period_start,period_end,responsible_label,revenue_target_cents,margin_target)
     values($1,$2,$3,$4,$5,$6::numeric/100)
     on conflict (company_id,period_start,period_end,responsible_label)
     do update set revenue_target_cents=excluded.revenue_target_cents,margin_target=excluded.margin_target`, [
		scope.companyId,
		goal.start,
		goal.end,
		goal.owner,
		goal.salesCents,
		goal.marginBasisPoints
	]);
}
/** Grava o que o comando mudou. Estado igual ao anterior (repetição idempotente) não grava nada. */
async function persistCommand(sql, scope, before, after, command) {
	if (after === before) return;
	const quote = (id) => after.quotes.find((item) => item.id === id);
	const version = (id) => after.versions.find((item) => item.id === id);
	let entity;
	switch (command.type) {
		case "saveCatalogItem":
			entity = command.item.id;
			await writeProduct(sql, scope, after.products.find((item) => item.id === entity));
			break;
		case "moveInventory":
			entity = command.movement.id;
			await writeMovement(sql, scope, command.movement);
			if (after.products !== before.products) await writeProduct(sql, scope, after.products.find((item) => item.id === command.movement.productId));
			break;
		case "saveQuote":
			entity = command.quote.id;
			await writeQuote(sql, scope, quote(entity), new Set(after.products.map((item) => item.id)));
			await writeVersion(sql, scope, version(command.eventId));
			break;
		case "approveQuote":
			entity = command.quoteId;
			await approve(sql, scope, quote(entity));
			await writeProject(sql, scope, after.projects.find((item) => item.id === command.projectId), quote(entity));
			await writeVersion(sql, scope, version(command.eventId));
			break;
		case "addPayment":
			entity = command.payment.projectId;
			await writePayment(sql, scope, command.payment);
			await sql.query("update projects set version=version+1,updated_at=now() where company_id=$1 and id=$2", [scope.companyId, entity]);
			break;
		case "moveProject":
			entity = command.projectId;
			await sql.query(`update projects set stage=$3,version=version+1,updated_at=now(),delivered_at=case when $3='delivered' then coalesce(delivered_at,now()) else delivered_at end where company_id=$1 and id=$2`, [
				scope.companyId,
				entity,
				command.stage
			]);
			break;
		case "planInstallments":
			entity = command.projectId;
			await sql.query("delete from project_installments where company_id=$1 and project_id=$2", [scope.companyId, entity]);
			await writeInstallments(sql, scope.companyId, command.installments);
			break;
		case "addExpense":
			entity = command.expense.id;
			await writeExpense(sql, scope, command.expense);
			break;
		case "payExpense":
			entity = command.expenseId;
			await sql.query("update operating_expenses set paid_on=$3 where company_id=$1 and id=$2", [
				scope.companyId,
				entity,
				command.paidOn
			]);
			break;
		case "saveGoal":
			entity = scope.companyId;
			await writeGoal(sql, scope, command.goal);
	}
	await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,$3,$4,$5::text::jsonb)", [
		scope.companyId,
		scope.userId,
		"commercial." + command.type,
		entity,
		JSON.stringify({ type: command.type })
	]);
}
const decimal = (milli) => {
	const n = BigInt(milli), a = n < 0n ? -n : n;
	return `${n < 0n ? "-" : ""}${a / 1000n}.${(a % 1000n).toString().padStart(3, "0")}`;
};
function writeInstallments(sql, companyId, installments) {
	return insertMany(sql, "project_installments", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		due_on: "date",
		amount_cents: "bigint"
	}, installments.map((item) => ({
		id: item.id,
		company_id: companyId,
		project_id: item.projectId,
		due_on: item.dueOn,
		amount_cents: item.amountCents
	})));
}
/** Muitas linhas numa consulta só: o JSON vira registros com o tipo de cada coluna. */
async function insertMany(sql, table, columns, rows) {
	if (!rows.length) return;
	const names = Object.keys(columns);
	await sql.query(`insert into ${table}(${names.join(",")}) select ${names.join(",")} from jsonb_to_recordset($1::text::jsonb) as x(${names.map((name) => name + " " + columns[name]).join(",")})`, [JSON.stringify(rows)]);
}
/** Ids novos na importação: o mesmo exemplo entra em várias empresas (as chaves são do banco todo). */
function renewIds(state) {
	const ids = /* @__PURE__ */ new Map();
	const id = (old) => {
		let next = ids.get(old);
		if (!next) ids.set(old, next = randomUUID());
		return next;
	};
	const quote = (item) => ({
		...item,
		id: id(item.id),
		items: item.items.map((line) => ({
			...line,
			id: id(line.id),
			productId: id(line.productId)
		}))
	});
	return {
		...state,
		products: state.products.map((item) => ({
			...item,
			id: id(item.id)
		})),
		quotes: state.quotes.map(quote),
		projects: state.projects.map((item) => ({
			...item,
			id: id(item.id),
			quoteId: id(item.quoteId)
		})),
		payments: state.payments.map((item) => ({
			...item,
			id: id(item.id),
			commandId: id(item.commandId),
			projectId: id(item.projectId)
		})),
		installments: state.installments.map((item) => ({
			...item,
			id: id(item.id),
			projectId: id(item.projectId)
		})),
		expenses: state.expenses.map((item) => ({
			...item,
			id: id(item.id),
			quoteId: item.quoteId && id(item.quoteId)
		})),
		inventory: state.inventory.map((item) => ({
			...item,
			id: id(item.id),
			productId: id(item.productId)
		})),
		versions: state.versions.map((item) => ({
			...item,
			id: id(item.id),
			quoteId: id(item.quoteId),
			snapshot: quote(item.snapshot)
		}))
	};
}
/** Leva para o banco os dados de um aparelho (ou o exemplo) numa empresa ainda vazia, uma consulta por tabela. */
async function importState(sql, scope, input) {
	const state = renewIds(DemoCommercialStateSchema.parse(input));
	const [used] = await sql.query("select exists(select 1 from catalog_items where company_id=$1) or exists(select 1 from commercial_quotes where company_id=$1) as used", [scope.companyId]);
	if (used?.used) throw new AppError("NOT_EMPTY", "A empresa já tem dados. A importação serve só para começar.", 409);
	const company_id = scope.companyId;
	const catalog = new Set(state.products.map((item) => item.id));
	const quotes = new Map(state.quotes.map((quote) => [quote.id, quote]));
	await insertMany(sql, "catalog_items", {
		id: "uuid",
		company_id: "uuid",
		sku: "text",
		name: "text",
		kind: "text",
		category: "text",
		unit: "text",
		price_cents: "bigint",
		cost_cents: "bigint",
		opening_stock: "numeric",
		minimum_stock: "numeric",
		maximum_stock: "numeric",
		active: "boolean",
		ncm: "text"
	}, state.products.map((item) => ({
		id: item.id,
		company_id,
		sku: item.sku,
		name: item.name,
		kind: item.kind,
		category: item.category,
		unit: item.unit,
		price_cents: item.priceCents,
		cost_cents: item.costCents,
		opening_stock: decimal(item.openingStockMilli),
		minimum_stock: decimal(item.minStockMilli),
		maximum_stock: item.maxStockMilli ? decimal(item.maxStockMilli) : null,
		active: item.active,
		ncm: item.ncm ?? null
	})));
	await insertMany(sql, "commercial_quotes", {
		id: "uuid",
		company_id: "uuid",
		code: "text",
		customer_name: "text",
		title: "text",
		responsible_label: "text",
		status: "text",
		revision: "integer",
		created_on: "date",
		valid_until: "date",
		due_date: "date",
		discount_cents: "bigint",
		shipping_cents: "bigint",
		shipping_cost_cents: "bigint",
		notes: "text"
	}, state.quotes.map((quote) => ({
		id: quote.id,
		company_id,
		code: quote.code,
		customer_name: quote.customerName,
		title: quote.title,
		responsible_label: quote.owner,
		status: quote.status === "approved" ? "sent" : quote.status,
		revision: quote.revision,
		created_on: quote.createdOn,
		valid_until: quote.validUntil,
		due_date: quote.dueDate,
		discount_cents: quote.discountCents,
		shipping_cents: quote.shippingCents,
		shipping_cost_cents: quote.shippingCostCents,
		notes: quote.notes
	})));
	await insertMany(sql, "commercial_quote_items", {
		id: "uuid",
		company_id: "uuid",
		quote_id: "uuid",
		product_id: "uuid",
		position: "integer",
		sku_snapshot: "text",
		description_snapshot: "text",
		kind_snapshot: "text",
		category_snapshot: "text",
		unit_snapshot: "text",
		quantity: "numeric",
		unit_price_cents: "bigint",
		unit_cost_cents: "bigint"
	}, state.quotes.flatMap((quote) => quote.items.map((item, position) => ({
		id: item.id,
		company_id,
		quote_id: quote.id,
		product_id: catalog.has(item.productId) ? item.productId : null,
		position,
		sku_snapshot: item.sku,
		description_snapshot: item.description,
		kind_snapshot: item.kind,
		category_snapshot: item.category,
		unit_snapshot: item.unit,
		quantity: decimal(item.quantityMilli),
		unit_price_cents: item.unitPriceCents,
		unit_cost_cents: item.unitCostCents
	}))));
	const approved = state.quotes.filter((quote) => quote.status === "approved");
	if (approved.length) await sql.query(`update commercial_quotes q set status='approved',approved_on=x.approved_on from jsonb_to_recordset($2::text::jsonb) as x(id uuid,approved_on date) where q.company_id=$1 and q.id=x.id`, [company_id, JSON.stringify(approved.map((quote) => ({
		id: quote.id,
		approved_on: quote.approvedOn
	})))]);
	await insertMany(sql, "commercial_quote_revisions", {
		id: "uuid",
		company_id: "uuid",
		quote_id: "uuid",
		revision: "integer",
		event: "text",
		snapshot: "jsonb",
		actor_id: "uuid",
		created_at: "timestamptz"
	}, state.versions.map((version) => ({
		id: version.id,
		company_id,
		quote_id: version.quoteId,
		revision: version.revision,
		event: version.reason.startsWith("Aprova") ? "approved" : "saved",
		snapshot: version.snapshot,
		actor_id: scope.userId,
		created_at: noon(version.createdOn)
	})));
	await insertMany(sql, "projects", {
		id: "uuid",
		company_id: "uuid",
		customer_name: "text",
		title: "text",
		stage: "text",
		total_cents: "bigint",
		planned_cost_cents: "bigint",
		due_date: "date",
		approved_at: "timestamptz",
		source_quote_id: "uuid",
		version: "integer",
		created_at: "timestamptz",
		updated_at: "timestamptz"
	}, state.projects.map((project) => {
		const quote = quotes.get(project.quoteId);
		const totals = quoteTotals(quote);
		return {
			id: project.id,
			company_id,
			customer_name: quote.customerName,
			title: quote.title,
			stage: project.stage,
			total_cents: totals.totalCents,
			planned_cost_cents: totals.costCents,
			due_date: project.dueDate,
			approved_at: noon(quote.approvedOn ?? project.createdOn),
			source_quote_id: quote.id,
			version: project.version,
			created_at: noon(project.createdOn),
			updated_at: noon(project.createdOn)
		};
	}));
	await insertMany(sql, "payments", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		amount_cents: "bigint",
		received_at: "timestamptz",
		received_on: "date",
		method: "text",
		command_id: "uuid",
		created_by: "uuid"
	}, state.payments.map((payment) => ({
		id: payment.id,
		company_id,
		project_id: payment.projectId,
		amount_cents: payment.amountCents,
		received_at: noon(payment.receivedOn),
		received_on: payment.receivedOn,
		method: payment.method,
		command_id: payment.commandId,
		created_by: scope.userId
	})));
	await writeInstallments(sql, company_id, state.installments);
	await insertMany(sql, "operating_expenses", {
		id: "uuid",
		company_id: "uuid",
		quote_id: "uuid",
		description: "text",
		category: "text",
		amount_cents: "bigint",
		incurred_on: "date",
		paid_on: "date",
		actor_id: "uuid"
	}, state.expenses.map((expense) => ({
		id: expense.id,
		company_id,
		quote_id: expense.quoteId,
		description: expense.description,
		category: expense.category,
		amount_cents: expense.amountCents,
		incurred_on: expense.incurredOn,
		paid_on: expense.paidOn,
		actor_id: scope.userId
	})));
	await insertMany(sql, "inventory_movements", {
		id: "uuid",
		company_id: "uuid",
		product_id: "uuid",
		delta: "numeric",
		reason: "text",
		occurred_on: "date",
		actor_id: "uuid",
		supplier: "text",
		unit_cost_cents: "bigint"
	}, state.inventory.map((movement) => ({
		id: movement.id,
		company_id,
		product_id: movement.productId,
		delta: decimal(movement.deltaMilli),
		reason: movement.reason,
		occurred_on: movement.occurredOn,
		actor_id: scope.userId,
		supplier: movement.supplier ?? null,
		unit_cost_cents: movement.unitCostCents ?? null
	})));
	await insertMany(sql, "company_goals", {
		company_id: "uuid",
		period_start: "date",
		period_end: "date",
		responsible_label: "text",
		revenue_target_cents: "bigint",
		margin_target: "numeric"
	}, state.goals.map((goal) => ({
		company_id,
		period_start: goal.start,
		period_end: goal.end,
		responsible_label: goal.owner,
		revenue_target_cents: goal.salesCents,
		margin_target: (goal.marginBasisPoints / 100).toFixed(2)
	})));
	await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,$3,$4,$5::text::jsonb)", [
		scope.companyId,
		scope.userId,
		"commercial.import",
		scope.companyId,
		JSON.stringify({ quotes: state.quotes.length })
	]);
}
// dist/fiscal.js
const plain = (name) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function focusNfe(tokens) {
	const host = {
		homologacao: "https://homologacao.focusnfe.com.br",
		producao: "https://api.focusnfe.com.br"
	};
	const paths = {
		nfe: "/nfe",
		nfse: "/nfsen"
	};
	const cities = /* @__PURE__ */ new Map();
	async function call(environment, path, init = {}) {
		const token = tokens[environment];
		if (!token) throw new AppError("FISCAL_OFF", "A emissão de notas neste ambiente ainda não foi ligada no servidor.", 503);
		const response = await fetch(host[environment] + "/v2" + path, {
			...init,
			headers: {
				authorization: "Basic " + btoa(token + ":"),
				"content-type": "application/json"
			},
			signal: AbortSignal.timeout(3e4)
		});
		if (response.status >= 500) throw new AppError("FISCAL_PROVIDER", "O provedor de notas não respondeu. Tente de novo.", 502);
		return await response.json().catch(() => ({}));
	}
	return {
		available: {
			homologacao: Boolean(tokens.homologacao),
			producao: Boolean(tokens.producao)
		},
		host,
		emit: (kind, environment, reference, payload) => call(environment, paths[kind] + "?ref=" + encodeURIComponent(reference), {
			method: "POST",
			body: JSON.stringify(payload)
		}),
		status: (kind, environment, reference) => call(environment, paths[kind] + "/" + encodeURIComponent(reference)),
		cancel: (kind, environment, reference, reason) => call(environment, paths[kind] + "/" + encodeURIComponent(reference), {
			method: "DELETE",
			body: JSON.stringify({ justificativa: reason })
		}),
		correct: (environment, reference, text) => call(environment, "/nfe/" + encodeURIComponent(reference) + "/carta_correcao", {
			method: "POST",
			body: JSON.stringify({ correcao: text })
		}),
		async cityCode(uf, name) {
			if (!cities.has(uf)) {
				const response = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/estados/" + uf + "/municipios", { signal: AbortSignal.timeout(1e4) }).catch(() => null);
				if (!response?.ok) throw new AppError("CITY_LOOKUP", "Não consegui conferir a cidade agora. Tente de novo.", 502);
				cities.set(uf, await response.json());
			}
			return cities.get(uf).find((city) => plain(city.nome) === plain(name))?.id.toString() ?? null;
		}
	};
}
/** Código do IBGE da cidade conferido pelo provedor; erro claro quando o nome não confere. */
async function cityOf(provider, uf, name, whose) {
	const code = provider && await provider.cityCode(uf, name);
	if (!code) throw new AppError("FISCAL_CITY", `Não achei a cidade ${whose} em ${uf}. Confira o nome.`, 400);
	return code;
}
const columns = "id,kind,quote_id,reference,environment,status,number,series,access_key,danfe_url,xml_url,message,recipient,total_cents::text as total,created_at::text as created,cancel_reason,cancel_xml_url";
const toDocument = (row, corrections = []) => FiscalDocumentSchema.parse({
	id: row.id,
	kind: row.kind,
	quoteId: row.quote_id,
	reference: row.reference,
	environment: row.environment,
	status: row.status,
	number: row.number,
	series: row.series,
	accessKey: row.access_key,
	danfeUrl: row.danfe_url,
	xmlUrl: row.xml_url,
	message: row.message,
	recipient: row.recipient,
	totalCents: row.total,
	createdAt: row.created,
	cancelReason: row.cancel_reason,
	cancelXmlUrl: row.cancel_xml_url,
	corrections
});
/** Notas com as cartas de correção de cada uma, em ordem. */
async function withCorrections(sql, companyId, rows) {
	const letters = rows.length ? await sql.query(`select document_id,sequence,text,pdf_url,xml_url,created_at::text as created from fiscal_corrections
         where company_id=$1 and document_id=any($2::uuid[]) order by sequence`, [companyId, rows.map((row) => row.id)]) : [];
	return rows.map((row) => toDocument(row, letters.filter((letter) => letter.document_id === row.id).map((letter) => ({
		sequence: Number(letter.sequence),
		text: letter.text,
		pdfUrl: letter.pdf_url,
		xmlUrl: letter.xml_url,
		createdAt: letter.created
	}))));
}
async function loadFiscal(sql, companyId) {
	const [settings] = await sql.query("select * from company_fiscal_settings where company_id=$1", [companyId]);
	const documents = await sql.query(`select ${columns} from fiscal_documents where company_id=$1 order by created_at desc limit 200`, [companyId]);
	return {
		settings: settings ? FiscalSettingsSchema.parse({
			cnpj: settings.cnpj,
			stateRegistration: settings.state_registration,
			taxRegime: Number(settings.tax_regime),
			uf: settings.uf,
			operationNature: settings.operation_nature,
			cfopInternal: settings.cfop_internal,
			cfopExternal: settings.cfop_external,
			defaultNcm: settings.default_ncm,
			icmsSituation: settings.icms_situation,
			pisSituation: settings.pis_situation,
			cofinsSituation: settings.cofins_situation,
			environment: settings.environment,
			city: settings.city,
			municipalRegistration: settings.municipal_registration,
			serviceCode: settings.service_code
		}) : null,
		documents: await withCorrections(sql, companyId, documents)
	};
}
/** Grava os dados fiscais; o código do IBGE da cidade chega já conferido (vazio sem cidade). */
async function saveFiscalSettings(sql, companyId, input, cityCode) {
	const settings = FiscalSettingsSchema.parse(input);
	await sql.query(`insert into company_fiscal_settings(company_id,cnpj,state_registration,tax_regime,uf,operation_nature,cfop_internal,cfop_external,default_ncm,icms_situation,pis_situation,cofins_situation,environment,city,city_code,municipal_registration,service_code)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (company_id) do update set cnpj=excluded.cnpj,state_registration=excluded.state_registration,
     tax_regime=excluded.tax_regime,uf=excluded.uf,operation_nature=excluded.operation_nature,cfop_internal=excluded.cfop_internal,
     cfop_external=excluded.cfop_external,default_ncm=excluded.default_ncm,icms_situation=excluded.icms_situation,
     pis_situation=excluded.pis_situation,cofins_situation=excluded.cofins_situation,environment=excluded.environment,city=excluded.city,
     city_code=excluded.city_code,municipal_registration=excluded.municipal_registration,service_code=excluded.service_code,updated_at=now()`, [
		companyId,
		settings.cnpj,
		settings.stateRegistration,
		settings.taxRegime,
		settings.uf,
		settings.operationNature,
		settings.cfopInternal,
		settings.cfopExternal,
		settings.defaultNcm,
		settings.icmsSituation,
		settings.pisSituation,
		settings.cofinsSituation,
		settings.environment,
		settings.city,
		cityCode,
		settings.municipalRegistration,
		settings.serviceCode
	]);
	return settings;
}
async function insertDocument(sql, scope, document) {
	const [busy] = await sql.query(`select status from fiscal_documents where company_id=$1 and quote_id=$2 and kind=$3 and status in ('enviando','processando_autorizacao','autorizado','cancelando') limit 1`, [
		scope.companyId,
		document.quoteId,
		document.kind
	]);
	if (busy) throw new AppError("NFE_EXISTS", `Este orçamento já tem ${document.kind === "nfe" ? "NF-e" : "NFS-e"} autorizada ou em processamento.`, 409);
	const [row] = await sql.query(`insert into fiscal_documents(company_id,kind,quote_id,reference,environment,status,recipient,total_cents,actor_id,dps_number)
     values($1,$2,$3,$4,$5,'enviando',$6::text::jsonb,$7,$8,$9) returning ${columns}`, [
		scope.companyId,
		document.kind,
		document.quoteId,
		document.reference,
		document.environment,
		JSON.stringify(document.recipient),
		document.totalCents,
		scope.userId,
		document.dpsNumber
	]);
	return toDocument(row);
}
async function documentById(sql, companyId, id) {
	const [row] = await sql.query(`select ${columns} from fiscal_documents where company_id=$1 and id=$2`, [companyId, id]);
	if (!row) throw new AppError("NOT_FOUND", "Nota não encontrada.", 404);
	return (await withCorrections(sql, companyId, [row]))[0];
}
/** Marca a nota autorizada como "cancelando", com o motivo e quem pediu; só nota autorizada pode ser cancelada. */
async function startCancel(sql, scope, id, reason) {
	const [row] = await sql.query(`update fiscal_documents set status='cancelando',cancel_reason=$3,cancel_actor_id=$4,cancel_requested_at=now(),updated_at=now()
     where company_id=$1 and id=$2 and status='autorizado' returning ${columns}`, [
		scope.companyId,
		id,
		reason,
		scope.userId
	]);
	if (row) return (await withCorrections(sql, scope.companyId, [row]))[0];
	await documentById(sql, scope.companyId, id);
	throw new AppError("FISCAL_CANCEL_STATUS", "Só nota autorizada pode ser cancelada.", 409);
}
/** O que a SEFAZ ou a prefeitura disse: a mensagem oficial, os erros com a correção sugerida ou a mensagem do provedor. */
const noteMessage = (note) => note.mensagem_sefaz ?? (note.erros?.flatMap((item) => [item.mensagem, item.correcao]).filter(Boolean).join(" ") || note.mensagem) ?? null;
/** Guarda o que o provedor respondeu; os caminhos do DANFE e dos XML viram endereços completos (o PDF da NFS-e já vem). */
async function applyNote(sql, companyId, document, note, host) {
	const message = noteMessage(note);
	const [row] = await sql.query(`update fiscal_documents set status=$3,number=$4,series=$5,access_key=$6,danfe_url=$7,xml_url=$8,message=$9,cancel_xml_url=$10,updated_at=now()
     where company_id=$1 and id=$2 returning ${columns}`, [
		companyId,
		document.id,
		note.status ?? "erro_autorizacao",
		note.numero ?? document.number,
		note.serie ?? document.series,
		note.chave_nfe ?? note.url?.match(/chave=(\d+)/)?.[1] ?? document.accessKey,
		note.caminho_danfe ? host + note.caminho_danfe : note.url_danfse ?? document.danfeUrl,
		note.caminho_xml_nota_fiscal ? host + note.caminho_xml_nota_fiscal : document.xmlUrl,
		message,
		note.caminho_xml_cancelamento ? host + note.caminho_xml_cancelamento : document.cancelXmlUrl
	]);
	return (await withCorrections(sql, companyId, [row]))[0];
}
/** Guarda a carta de correção autorizada; o número vem do provedor (ou segue a última). */
async function insertCorrection(sql, scope, document, text, note, host) {
	await sql.query(`insert into fiscal_corrections(company_id,document_id,sequence,text,pdf_url,xml_url,message,actor_id)
     values($1,$2,$3,$4,$5,$6,$7,$8)`, [
		scope.companyId,
		document.id,
		note.numero_carta_correcao ?? (document.corrections.at(-1)?.sequence ?? 0) + 1,
		text,
		note.caminho_pdf_carta_correcao ? host + note.caminho_pdf_carta_correcao : null,
		note.caminho_xml_carta_correcao ? host + note.caminho_xml_carta_correcao : null,
		note.mensagem_sefaz ?? null,
		scope.userId
	]);
	return documentById(sql, scope.companyId, document.id);
}
// dist/projects.js
const writers = [
	"admin",
	"manager",
	"sales",
	"production",
	"finance"
];
const fiscalManagers = [
	"admin",
	"manager",
	"finance"
];
const projection = `p.*, COALESCE((SELECT sum(py.amount_cents) FROM payments py WHERE py.company_id=p.company_id AND py.project_id=p.id),0)-COALESCE((SELECT sum(py.amount_cents) FROM payment_reversals r JOIN payments py ON py.id=r.payment_id AND py.company_id=r.company_id WHERE py.company_id=p.company_id AND py.project_id=p.id),0) AS received_cents`;
function project(row) {
	return ProjectSchema.parse({
		id: row.id,
		companyId: row.company_id,
		customerId: row.customer_id,
		customerName: row.customer_name,
		title: row.title,
		totalCents: String(row.total_cents),
		plannedCostCents: String(row.planned_cost_cents),
		receivedCents: String(row.received_cents),
		stage: row.stage,
		version: row.version,
		notes: row.notes,
		dueDate: row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date.slice(0, 10),
		createdAt: new Date(row.created_at).toISOString()
	});
}
var ProjectService = class {
	database;
	constructor(database) {
		this.database = database;
	}
	/** Transação só com a identidade do token, para o que vem antes de escolher a empresa. */
	async personal(actor, operation) {
		return this.database.transaction(async (sql) => {
			await sql.query("select set_config('statement_timeout','5000',true),set_config('app.issuer',$1,true),set_config('app.subject',$2,true)", [actor.issuer, actor.subject]);
			return operation(sql);
		});
	}
	async companies(actor) {
		return this.personal(actor, async (sql) => (await sql.query("select id,name,role from praiamar_my_companies()")).map((row) => CompanySchema.parse(row)));
	}
	/** Cria a empresa e, com dados de exemplo, já os grava na mesma transação: a entrada faz uma chamada só. */
	async createCompany(actor, name, example) {
		return this.personal(actor, async (sql) => {
			const [row] = await sql.query("select praiamar_create_company($1,$2) as id", [name, (actor.name ?? "Usuário").slice(0, 160)]);
			const company = CompanySchema.parse({
				id: row?.id,
				name,
				role: "admin"
			});
			if (!example) return company;
			const [user] = await sql.query("select id from app_users where issuer=$1 and subject=$2", [actor.issuer, actor.subject]);
			const scope = {
				companyId: company.id,
				userId: user.id
			};
			await sql.query("select set_config('app.company_id',$1,true),set_config('app.user_id',$2,true)", [scope.companyId, scope.userId]);
			await importState(sql, scope, example);
			return {
				...company,
				state: await loadState(sql, company.id, today())
			};
		});
	}
	async commercialState(actor, companyId) {
		return this.scoped(actor, companyId, null, (sql) => loadState(sql, companyId, today()));
	}
	/** Um comando por vez por empresa: a trava da transação evita que duas telas apliquem sobre o mesmo estado. */
	async commercialCommand(actor, companyId, command) {
		return this.scoped(actor, companyId, writers, async (sql, context) => {
			await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
			const before = await loadState(sql, companyId, today());
			const after = applyCommercialCommand(before, command);
			await persistCommand(sql, context, before, after, command);
			return after;
		});
	}
	/** Painel de controle: preferências de quem entrou e padrões da empresa (o que faltar volta ao valor de fábrica). */
	async settings(actor, companyId) {
		return this.scoped(actor, companyId, null, async (sql, context) => {
			const [user] = await sql.query("select settings from user_settings where user_id=$1", [context.userId]);
			const [company] = await sql.query("select settings from company_settings where company_id=$1", [companyId]);
			const [named] = await sql.query("select name from companies where id=$1", [companyId]);
			return SettingsSchema.parse({
				user: user?.settings ?? {},
				company: company?.settings ?? {},
				companyName: named?.name ?? ""
			});
		});
	}
	/** Tema e texto maior de cada pessoa: valem em qualquer aparelho em que ela entrar. */
	async saveUserSettings(actor, companyId, input) {
		return this.scoped(actor, companyId, null, async (sql, context) => {
			const settings = UserSettingsSchema.parse(input);
			await sql.query("insert into user_settings(user_id,settings) values($1,$2::text::jsonb) on conflict (user_id) do update set settings=excluded.settings,updated_at=now()", [context.userId, JSON.stringify(settings)]);
			return settings;
		});
	}
	/** Nome e padrões da empresa: só administrador e gestor. */
	async saveCompanySettings(actor, companyId, name, input) {
		return this.scoped(actor, companyId, ["admin", "manager"], async (sql, context) => {
			const settings = CompanySettingsSchema.parse(input);
			await sql.query("update companies set name=$2 where id=$1 and name<>$2", [companyId, name]);
			await sql.query("insert into company_settings(company_id,settings) values($1,$2::text::jsonb) on conflict (company_id) do update set settings=excluded.settings,updated_at=now()", [companyId, JSON.stringify(settings)]);
			await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'company.settings',$1,$3::text::jsonb)", [
				companyId,
				context.userId,
				JSON.stringify({ name })
			]);
			return {
				name,
				settings
			};
		});
	}
	/** Fotos do catálogo numa chamada só, à parte do estado (que continua leve). */
	async catalogPhotos(actor, companyId) {
		return this.scoped(actor, companyId, null, async (sql) => {
			const rows = await sql.query("select item_id,image from catalog_photos where company_id=$1", [companyId]);
			return Object.fromEntries(rows.map((row) => [row.item_id, row.image]));
		});
	}
	/** Põe, troca ou tira (image nula) a foto de um item do catálogo. */
	async saveCatalogPhoto(actor, companyId, itemId, image) {
		return this.scoped(actor, companyId, writers, async (sql, context) => {
			const [item] = await sql.query("select 1 from catalog_items where company_id=$1 and id=$2", [companyId, itemId]);
			if (!item) throw new AppError("NOT_FOUND", "Item não encontrado.", 404);
			if (image) await sql.query("insert into catalog_photos(company_id,item_id,image) values($1,$2,$3) on conflict (company_id,item_id) do update set image=excluded.image,updated_at=now()", [
				companyId,
				itemId,
				image
			]);
			else await sql.query("delete from catalog_photos where company_id=$1 and item_id=$2", [companyId, itemId]);
			await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'catalog.photo',$3,$4::text::jsonb)", [
				companyId,
				context.userId,
				itemId,
				JSON.stringify({ removed: !image })
			]);
			return {
				itemId,
				image
			};
		});
	}
	async fiscalOverview(actor, companyId) {
		return this.scoped(actor, companyId, null, (sql) => loadFiscal(sql, companyId));
	}
	async saveFiscalSettings(actor, companyId, settings, provider) {
		const cityCode = settings.city ? await cityOf(provider, settings.uf, settings.city, "da empresa") : "";
		return this.scoped(actor, companyId, fiscalManagers, (sql) => saveFiscalSettings(sql, companyId, settings, cityCode));
	}
	async emitNfe(actor, companyId, request, provider) {
		return this.emitDocument(actor, companyId, "nfe", request, provider, async (_sql, state, settings) => buildNfe(state, request.quoteId, settings, request.recipient, request.payment, (/* @__PURE__ */ new Date()).toISOString()));
	}
	/** A DPS é numerada em sequência por ambiente; a trava na linha dos dados fiscais evita dois números iguais. */
	async emitNfse(actor, companyId, request, provider) {
		const recipientCityCode = await cityOf(provider, request.recipient.uf, request.recipient.city, "do cliente");
		return this.emitDocument(actor, companyId, "nfse", request, provider, async (sql, state, settings) => {
			const [row] = await sql.query(`select city_code,(select coalesce(max(dps_number),0)+1 from fiscal_documents
          where company_id=$1 and environment=$2 and kind='nfse')::int as next
         from company_fiscal_settings where company_id=$1 for update`, [companyId, settings.environment]);
			const dps = {
				number: row.next,
				issuedAt: (/* @__PURE__ */ new Date()).toISOString(),
				date: today(),
				cityCode: row.city_code,
				recipientCityCode
			};
			return {
				...buildNfse(state, request.quoteId, settings, request.recipient, request.description, dps),
				dpsNumber: dps.number
			};
		});
	}
	/** Emite em três passos: grava a nota como "enviando", chama o provedor fora da transação e guarda a resposta. */
	async emitDocument(actor, companyId, kind, request, provider, build) {
		const { document, payload } = await this.scoped(actor, companyId, writers, async (sql, context) => {
			const { settings } = await loadFiscal(sql, companyId);
			if (!settings) throw new AppError("FISCAL_SETTINGS", "Preencha os dados fiscais da empresa antes de emitir.", 400);
			if (!provider.available[settings.environment]) throw new AppError("FISCAL_OFF", "A emissão de notas neste ambiente ainda não foi ligada no servidor.", 503);
			const built = await build(sql, await loadState(sql, companyId, today()), settings);
			return {
				document: await insertDocument(sql, context, {
					kind,
					quoteId: request.quoteId,
					reference: "praiamar-" + randomUUID(),
					environment: settings.environment,
					recipient: request.recipient,
					totalCents: built.totalCents,
					dpsNumber: built.dpsNumber ?? null
				}),
				payload: built.payload
			};
		});
		let note;
		try {
			note = await provider.emit(kind, document.environment, document.reference, payload);
		} catch (error) {
			note = {
				status: "erro_autorizacao",
				mensagem: error instanceof AppError ? error.message : "O provedor não respondeu."
			};
		}
		return this.scoped(actor, companyId, writers, (sql) => applyNote(sql, companyId, document, note, provider.host[document.environment]));
	}
	async refreshNfe(actor, companyId, id, provider) {
		const document = await this.scoped(actor, companyId, null, (sql) => documentById(sql, companyId, id));
		if (![
			"enviando",
			"processando_autorizacao",
			"cancelando"
		].includes(document.status)) return document;
		const note = await provider.status(document.kind, document.environment, document.reference);
		if (document.status === "cancelando" && !note.status) return document;
		return this.scoped(actor, companyId, writers, (sql) => applyNote(sql, companyId, document, note, provider.host[document.environment]));
	}
	/**
	* Cancela como emite: marca "cancelando", pede ao provedor fora da transação e guarda a resposta. Recusada, a nota
	* volta a autorizada com o motivo da recusa; sem resposta, fica "cancelando" até o Atualizar consultar o provedor.
	*/
	async cancelNote(actor, companyId, id, reason, provider) {
		const document = await this.scoped(actor, companyId, fiscalManagers, async (sql, context) => {
			const current = await documentById(sql, companyId, id);
			if (!provider.available[current.environment]) throw new AppError("FISCAL_OFF", "A emissão de notas neste ambiente ainda não foi ligada no servidor.", 503);
			return startCancel(sql, context, id, reason);
		});
		let note;
		try {
			note = await provider.cancel(document.kind, document.environment, document.reference, reason);
		} catch {
			throw new AppError("FISCAL_PROVIDER", "O provedor de notas não respondeu. Use Atualizar para conferir o cancelamento.", 502);
		}
		const cancelled = note.status === "cancelado";
		if (cancelled && !note.caminho_xml_cancelamento) note = {
			...note,
			...await provider.status(document.kind, document.environment, document.reference).catch(() => ({}))
		};
		const saved = await this.scoped(actor, companyId, fiscalManagers, (sql) => applyNote(sql, companyId, document, cancelled ? note : {
			...note,
			status: "autorizado"
		}, provider.host[document.environment]));
		if (!cancelled) throw new AppError("FISCAL_CANCEL", saved.message ?? "O cancelamento foi recusado.", 422);
		return saved;
	}
	/** Carta de correção da NF-e autorizada: confere a nota, pede ao provedor fora da transação e guarda a carta aceita. */
	async correctNfe(actor, companyId, id, text, provider) {
		const document = await this.scoped(actor, companyId, writers, async (sql) => {
			const current = await documentById(sql, companyId, id);
			if (current.kind !== "nfe") throw new AppError("FISCAL_CORRECTION_KIND", "Carta de correção é só da NF-e; a NFS-e se corrige cancelando e emitindo outra.", 400);
			if (current.status !== "autorizado") throw new AppError("FISCAL_CORRECTION_STATUS", "Só NF-e autorizada recebe carta de correção.", 409);
			if (current.corrections.length >= 20) throw new AppError("FISCAL_CORRECTION_LIMIT", "Esta NF-e já tem 20 cartas de correção, o limite da SEFAZ.", 409);
			if (!provider.available[current.environment]) throw new AppError("FISCAL_OFF", "A emissão de notas neste ambiente ainda não foi ligada no servidor.", 503);
			return current;
		});
		let note;
		try {
			note = await provider.correct(document.environment, document.reference, text);
		} catch {
			throw new AppError("FISCAL_PROVIDER", "O provedor de notas não respondeu. Envie a carta de novo.", 502);
		}
		if (note.status !== "autorizado") throw new AppError("FISCAL_CORRECTION", noteMessage(note) ?? "A carta de correção foi recusada.", 422);
		return this.scoped(actor, companyId, writers, (sql, context) => insertCorrection(sql, context, document, text, note, provider.host[document.environment]));
	}
	async importCommercial(actor, companyId, state) {
		return this.scoped(actor, companyId, ["admin"], async (sql, context) => {
			await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
			await importState(sql, context, state);
			return loadState(sql, companyId, today());
		});
	}
	async scoped(actor, companyId, roles, operation) {
		return this.database.transaction(async (sql) => {
			await sql.query("select set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
			await sql.query(`select set_config('app.issuer',$1,true),set_config('app.subject',$2,true),set_config('app.company_id',$3,true)`, [
				actor.issuer,
				actor.subject,
				companyId
			]);
			const [user] = await sql.query("select id from app_users where issuer=$1 and subject=$2", [actor.issuer, actor.subject]);
			if (!user) throw new AppError("FORBIDDEN", "Usuário ainda não autorizado para esta empresa.", 403);
			await sql.query(`select set_config('app.user_id',$1,true)`, [user.id]);
			const [membership] = await sql.query("select role from memberships where company_id=$1 and user_id=$2 and active", [companyId, user.id]);
			if (!membership) throw new AppError("FORBIDDEN", "Acesso à empresa não autorizado.", 403);
			const role = RoleSchema.parse(membership.role);
			if (roles && !roles.includes(role)) throw new AppError("FORBIDDEN", "Sua função não permite esta ação.", 403);
			return operation(sql, {
				companyId,
				userId: user.id,
				role
			});
		});
	}
	async idempotent(sql, context, operation, key, payload, action) {
		const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		if (!(await sql.query(`insert into idempotency_keys(company_id,actor_id,operation,key,payload_hash) values($1,$2,$3,$4,$5) on conflict do nothing returning payload_hash`, [
			context.companyId,
			context.userId,
			operation,
			key,
			hash
		])).length) {
			const [cached] = await sql.query(`select payload_hash,response from idempotency_keys where company_id=$1 and actor_id=$2 and operation=$3 and key=$4`, [
				context.companyId,
				context.userId,
				operation,
				key
			]);
			if (!cached || cached.payload_hash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "A chave já foi usada para outra operação.");
			return cached.response;
		}
		const result = await action();
		await sql.query(`update idempotency_keys set response=$5::text::jsonb,status_code=201 where company_id=$1 and actor_id=$2 and operation=$3 and key=$4`, [
			context.companyId,
			context.userId,
			operation,
			key,
			JSON.stringify(result)
		]);
		return result;
	}
	async list(actor, companyId, limit, cursor) {
		return this.scoped(actor, companyId, null, async (sql) => {
			const rows = await sql.query(`select ${projection} from projects p where p.company_id=$1 ${cursor ? "and (p.created_at,p.id)<($3::timestamptz,$4::uuid)" : ""} order by p.created_at desc,p.id desc limit $2`, cursor ? [
				companyId,
				limit + 1,
				cursor.createdAt,
				cursor.id
			] : [companyId, limit + 1]);
			const items = rows.slice(0, limit).map(project);
			const last = items.at(-1);
			return {
				items,
				nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
					createdAt: last.createdAt,
					id: last.id
				})).toString("base64url") : null
			};
		});
	}
	async create(actor, companyId, key, input) {
		return this.scoped(actor, companyId, [
			"admin",
			"manager",
			"sales"
		], (sql, context) => this.idempotent(sql, context, "project.create", key, input, async () => {
			const [row] = await sql.query(`insert into projects(company_id,customer_id,customer_name,title,total_cents,planned_cost_cents,due_date,notes) values($1,$2,$3,$4,$5,$6,$7,$8) returning *,0::bigint as received_cents`, [
				companyId,
				input.customerId,
				input.customerName,
				input.title,
				input.totalCents,
				input.plannedCostCents,
				input.dueDate,
				input.notes
			]);
			if (!row) throw new Error("Insert returned no project");
			await sql.query(`insert into audit_events(company_id,actor_id,action,entity_id) values($1,$2,'project.created',$3)`, [
				companyId,
				context.userId,
				row.id
			]);
			return project(row);
		}));
	}
	async receive(actor, companyId, id, key, input) {
		return this.scoped(actor, companyId, [
			"admin",
			"manager",
			"finance"
		], (sql, context) => this.idempotent(sql, context, "project.payment:" + id, key, input, async () => {
			const [row] = await sql.query(`select ${projection} from projects p where p.company_id=$1 and p.id=$2 for update of p`, [companyId, id]);
			if (!row) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
			if (row.stage === "quotation" || row.stage === "cancelled") throw new AppError("STAGE_BLOCKED", "O projeto precisa estar aprovado para receber pagamentos.");
			if (row.version !== input.expectedVersion) throw new AppError("VERSION_CONFLICT", "O projeto mudou. Atualize os dados antes de confirmar.");
			const balanceCents = validateReceipt(String(row.total_cents), String(row.received_cents), input.amountCents);
			const [payment] = await sql.query(`insert into payments(company_id,project_id,amount_cents,created_by) values($1,$2,$3,$4) returning id`, [
				companyId,
				id,
				input.amountCents,
				context.userId
			]);
			if (!payment) throw new Error("Insert returned no payment");
			await sql.query(`update projects set version=version+1,updated_at=now() where company_id=$1 and id=$2`, [companyId, id]);
			await sql.query(`insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'payment.received',$3,$4::text::jsonb)`, [
				companyId,
				context.userId,
				payment.id,
				JSON.stringify({
					projectId: id,
					amountCents: input.amountCents
				})
			]);
			await sql.query(`insert into outbox_events(company_id,type,payload) values($1,'payment.received',$2::text::jsonb)`, [companyId, JSON.stringify({
				projectId: id,
				paymentId: payment.id
			})]);
			return {
				paymentId: payment.id,
				projectId: id,
				amountCents: input.amountCents,
				balanceCents,
				version: row.version + 1
			};
		}));
	}
	async advance(actor, companyId, id, expectedVersion) {
		return this.scoped(actor, companyId, [
			"admin",
			"manager",
			"production"
		], async (sql, context) => {
			const [row] = await sql.query(`select ${projection} from projects p where p.company_id=$1 and p.id=$2 for update of p`, [companyId, id]);
			if (!row) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
			if (row.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "O projeto mudou. Atualize os dados.");
			if (row.stage === "quotation" && context.role === "production") throw new AppError("FORBIDDEN", "A aprovação comercial exige um gestor.", 403);
			const [counts] = await sql.query(`select (select count(*)::integer from project_materials where company_id=$1 and project_id=$2 and received_quantity<ordered_quantity) pending,(select count(*)::integer from project_tasks where company_id=$1 and project_id=$2 and completed_at is null) incomplete`, [companyId, id]);
			const current = project(row);
			const stage = nextStage(current.stage, {
				pendingMaterials: (counts?.pending ?? 0) > 0,
				incompleteTasks: counts?.incomplete ?? 0,
				plannedCostCents: current.plannedCostCents
			});
			const [updated] = await sql.query(`update projects set stage=$3,version=version+1,updated_at=now(),approved_at=case when stage='quotation' then now() else approved_at end,delivered_at=case when $3='delivered' then now() else delivered_at end where company_id=$1 and id=$2 returning *, $4::bigint received_cents`, [
				companyId,
				id,
				stage,
				String(row.received_cents)
			]);
			if (!updated) throw new Error("Update returned no project");
			await sql.query(`insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'project.advanced',$3,$4::text::jsonb)`, [
				companyId,
				context.userId,
				id,
				JSON.stringify({
					from: current.stage,
					to: stage
				})
			]);
			return project(updated);
		});
	}
};
// dist/app.js
async function createApp(options) {
	const app = Fastify({
		logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false,
		bodyLimit: 131072,
		genReqId: () => randomUUID(),
		requestIdHeader: false,
		trustProxy: false
	});
	const service = new ProjectService(options.database);
	await app.register(helmet);
	await app.register(cors, {
		origin: options.origins,
		credentials: false,
		allowedHeaders: [
			"authorization",
			"content-type",
			"x-company-id",
			"idempotency-key"
		],
		maxAge: 7200
	});
	await app.register(rateLimit, {
		max: 120,
		timeWindow: "1 minute"
	});
	app.addHook("onSend", async (request, reply, payload) => {
		reply.header("x-request-id", request.id);
		return payload;
	});
	app.setErrorHandler((error, request, reply) => {
		if (error instanceof z.ZodError) return reply.code(400).send({
			code: "VALIDATION",
			message: "Confira os campos informados.",
			issues: error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message
			})),
			requestId: request.id
		});
		if (error instanceof AppError) return reply.code(error.status).send({
			code: error.code,
			message: error.message,
			requestId: request.id
		});
		const status = error.statusCode;
		if (status && status >= 400 && status < 500) return reply.code(status).send({
			code: status === 429 ? "RATE_LIMITED" : "BAD_REQUEST",
			message: status === 429 ? "Muitas solicitações. Aguarde antes de tentar novamente." : "A solicitação não é válida.",
			requestId: request.id
		});
		if ([
			"55P03",
			"57014",
			"ECONNREFUSED",
			"CONNECT_TIMEOUT",
			"CONNECTION_CLOSED"
		].includes(String(error.code))) return reply.code(503).send({
			code: "DATABASE_BUSY",
			message: "O sistema está ocupado. Atualize os dados e tente novamente.",
			requestId: request.id
		});
		request.log.error({ err: error }, "request failed");
		return reply.code(500).send({
			code: "INTERNAL",
			message: "Não foi possível concluir a operação.",
			requestId: request.id
		});
	});
	app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
	app.get("/health/ready", { config: { rateLimit: false } }, async (_request, reply) => {
		try {
			await options.database.health();
			return { status: "ready" };
		} catch {
			return reply.code(503).send({ status: "unavailable" });
		}
	});
	app.get("/openapi.json", async () => openApi);
	async function identify(headers) {
		const auth = typeof headers.authorization === "string" ? headers.authorization : "";
		if (!auth.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "Entre novamente para continuar.", 401);
		try {
			return await options.verifyToken(auth.slice(7));
		} catch {
			throw new AppError("UNAUTHENTICATED", "A sessão expirou ou não é válida.", 401);
		}
	}
	async function context(headers) {
		return {
			actor: await identify(headers),
			companyId: z.uuid().parse(headers["x-company-id"])
		};
	}
	app.get("/v1/me", async (request) => {
		const actor = await identify(request.headers);
		const companies = await service.companies(actor);
		const { state } = z.object({ state: z.literal("1").optional() }).parse(request.query);
		const first = companies[0];
		return {
			companies,
			assistant: Boolean(options.assistant),
			...state && first && { state: await service.commercialState(actor, first.id) }
		};
	});
	app.post("/v1/companies", { bodyLimit: 4194304 }, async (request, reply) => {
		const actor = await identify(request.headers);
		const { name, example } = z.object({
			name: z.string().trim().min(2).max(160),
			example: DemoCommercialStateSchema.optional()
		}).strict().parse(request.body);
		return reply.code(201).send(await service.createCompany(actor, name, example));
	});
	app.get("/v1/commercial/state", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.commercialState(actor, companyId);
	});
	app.post("/v1/commercial/commands", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.commercialCommand(actor, companyId, CommercialCommandSchema.parse(request.body));
	});
	app.get("/v1/settings", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.settings(actor, companyId);
	});
	app.put("/v1/settings/user", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.saveUserSettings(actor, companyId, UserSettingsSchema.parse(request.body));
	});
	app.put("/v1/settings/company", async (request) => {
		const { actor, companyId } = await context(request.headers), body = CompanySettingsBodySchema.parse(request.body);
		return service.saveCompanySettings(actor, companyId, body.name, body.settings);
	});
	app.get("/v1/catalog/photos", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.catalogPhotos(actor, companyId);
	});
	app.put("/v1/catalog/:id/photo", { bodyLimit: 1048576 }, async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.saveCatalogPhoto(actor, companyId, id, CatalogPhotoBodySchema.parse(request.body).image);
	});
	app.post("/v1/commercial/import", { bodyLimit: 4194304 }, async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.importCommercial(actor, companyId, DemoCommercialStateSchema.parse(request.body));
	});
	const fiscal = () => {
		if (!options.fiscal) throw new AppError("FISCAL_OFF", "A emissão de notas ainda não foi ligada no servidor.", 503);
		return options.fiscal;
	};
	app.get("/v1/fiscal", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return {
			available: options.fiscal?.available ?? {
				homologacao: false,
				producao: false
			},
			...await service.fiscalOverview(actor, companyId)
		};
	});
	app.put("/v1/fiscal/settings", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.saveFiscalSettings(actor, companyId, FiscalSettingsSchema.parse(request.body), options.fiscal);
	});
	app.post("/v1/fiscal/nfe", async (request, reply) => {
		const { actor, companyId } = await context(request.headers);
		return reply.code(201).send(await service.emitNfe(actor, companyId, NfeRequestSchema.parse(request.body), fiscal()));
	});
	app.post("/v1/fiscal/nfse", async (request, reply) => {
		const { actor, companyId } = await context(request.headers);
		return reply.code(201).send(await service.emitNfse(actor, companyId, NfseRequestSchema.parse(request.body), fiscal()));
	});
	app.post("/v1/fiscal/nfe/:id/refresh", async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.refreshNfe(actor, companyId, id, fiscal());
	});
	app.post("/v1/fiscal/nfe/:id/cancel", async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.cancelNote(actor, companyId, id, FiscalCancelSchema.parse(request.body).reason, fiscal());
	});
	app.post("/v1/fiscal/nfe/:id/correction", async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.correctNfe(actor, companyId, id, FiscalCorrectionRequestSchema.parse(request.body).text, fiscal());
	});
	app.get("/v1/assistant", async (request) => {
		await context(request.headers);
		return { available: Boolean(options.assistant) };
	});
	app.post("/v1/assistant", { config: { rateLimit: {
		max: 20,
		timeWindow: "1 minute"
	} } }, async (request) => {
		const { actor, companyId } = await context(request.headers);
		if (!options.assistant) throw new AppError("ASSISTANT_OFF", "O assistente ainda não foi ativado.", 503);
		const { messages } = AssistantRequestSchema.parse(request.body);
		return { reply: await options.assistant(await service.commercialState(actor, companyId), messages) };
	});
	app.get("/v1/projects", async (request) => {
		const { actor, companyId } = await context(request.headers);
		const query = z.object({
			limit: z.coerce.number().int().min(1).max(100).default(25),
			cursor: z.string().max(512).optional()
		}).parse(request.query);
		let cursor;
		if (query.cursor) try {
			cursor = z.object({
				createdAt: z.iso.datetime(),
				id: z.uuid()
			}).parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
		} catch {
			throw new AppError("VALIDATION", "Cursor de página inválido.", 400);
		}
		return service.list(actor, companyId, query.limit, cursor);
	});
	app.post("/v1/projects", async (request, reply) => {
		const { actor, companyId } = await context(request.headers);
		const key = IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
		return reply.code(201).send(await service.create(actor, companyId, key, CreateProjectSchema.parse(request.body)));
	});
	app.post("/v1/projects/:id/payments", async (request, reply) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		const key = IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
		return reply.code(201).send(await service.receive(actor, companyId, id, key, PaymentCommandSchema.parse(request.body)));
	});
	app.post("/v1/projects/:id/advance", async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.advance(actor, companyId, id, AdvanceCommandSchema.parse(request.body).expectedVersion);
	});
	return app;
}
// dist/assistant.js
const instructions = `Você é o assistente do PraiaMar Gestão, sistema de orçamentos, produtos e serviços, projetos e
financeiro de uma marcenaria. Quem pergunta é o dono ou alguém da equipe, muitas vezes pelo celular.
Responda em português do Brasil, direto e curto, em texto simples: sem tabelas, sem markdown e sem códigos internos.
Escreva valores em reais como nos dados. Use somente os dados da empresa abaixo; se faltar algo, diga o que falta.
Você não altera nada no sistema: quando sugerir uma ação, diga em qual tela fazer (Hoje, Orçamentos, Produtos e
serviços, Projetos, Financeiro ou Números do negócio). Para preço de item novo, parta do custo e da margem que a
empresa costuma praticar nos dados.`;
const percent = (basisPoints) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(basisPoints / 100) + "%";
const statusText = {
	draft: "rascunho",
	sent: "em negociação",
	approved: "aprovado",
	lost: "não fechado",
	expired: "vencido"
};
/** Resumo dos dados da empresa em texto, montado pelas mesmas regras do domínio que as telas usam. */
function businessContext(state) {
	const today = state.referenceDate;
	const month = today.slice(0, 7);
	const sixMonths = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 6, 1)).toISOString().slice(0, 10);
	const numbers = (start) => {
		const data = calculateAnalytics(state, {
			start,
			end: today,
			owner: "all",
			compare: false
		});
		return `vendas aprovadas ${formatMoney(data.salesCents)}, custo previsto ${formatMoney(data.costCents)}, despesas ${formatMoney(data.expenseCents)}, resultado estimado ${formatMoney(data.resultCents)}, margem ${percent(data.marginBasisPoints)}, recebido ${formatMoney(data.cashInCents)}, orçamentos que viraram venda ${percent(data.conversionBasisPoints)}`;
	};
	return [
		`Hoje: ${today}.`,
		`Mês atual (${month}): ${numbers(month + "-01")}.`,
		`Últimos seis meses (desde ${sixMonths}): ${numbers(sixMonths)}.`,
		"",
		"Orçamentos em aberto (título; cliente; responsável; situação; total; custo; válido até; entrega):",
		...state.quotes.filter((quote) => quote.status === "draft" || quote.status === "sent").slice(0, 80).map((quote) => {
			const totals = quoteTotals(quote);
			return `- ${quote.title}; ${quote.customerName}; ${quote.owner}; ${statusText[effectiveQuoteStatus(quote, today)]}; ${formatMoney(totals.totalCents)}; ${formatMoney(totals.costCents)}; ${quote.validUntil}; ${quote.dueDate}`;
		}),
		"",
		"Projetos (título; cliente; etapa; total; recebido; falta receber; entrega):",
		...state.projects.slice(0, 80).map((project) => {
			const quote = state.quotes.find((item) => item.id === project.quoteId);
			return `- ${quote?.title}; ${quote?.customerName}; ${project.stage}; ${quote ? formatMoney(quoteTotals(quote).totalCents) : "?"}; ${formatMoney(receivedForProject(state, project.id))}; ${formatMoney(projectBalance(state, project.id))}; ${project.dueDate}`;
		}),
		"",
		"Produtos e serviços ativos (nome; tipo; categoria; preço por unidade; custo; estoque e mínimo):",
		...state.products.filter((product) => product.active).slice(0, 150).map((product) => `- ${product.name}; ${product.kind}; ${product.category}; ${formatMoney(product.priceCents)}/${product.unit}; ${formatMoney(product.costCents)}; ${product.kind === "service" ? "sem estoque" : `${formatQuantity(stockMilli(state, product.id))} (mínimo ${formatQuantity(product.minStockMilli)})`}`),
		"",
		"Despesas dos últimos seis meses (descrição; categoria; valor; data; paga em):",
		...state.expenses.filter((expense) => expense.incurredOn >= sixMonths).slice(0, 80).map((expense) => `- ${expense.description}; ${expense.category}; ${formatMoney(expense.amountCents)}; ${expense.incurredOn}; ${expense.paidOn ?? "a pagar"}`)
	].join("\n");
}
function createAssistant(apiKey) {
	if (!apiKey) return void 0;
	let sdk, client;
	return async (state, messages) => {
		sdk ??= await import("@anthropic-ai/sdk");
		const Sdk = sdk.default;
		client ??= new Sdk({
			apiKey,
			timeout: 12e4,
			maxRetries: 1
		});
		let response;
		try {
			response = await client.beta.messages.create({
				model: "claude-opus-5-5",
				max_tokens: 16e3,
				betas: ["server-side-fallback-2026-07-01"],
				fallbacks: "default",
				output_config: { effort: "medium" },
				cache_control: { type: "ephemeral" },
				system: [{
					type: "text",
					text: instructions
				}, {
					type: "text",
					text: businessContext(state)
				}],
				messages
			});
		} catch (error) {
			if (error instanceof Sdk.RateLimitError) throw new AppError("ASSISTANT_BUSY", "O assistente está ocupado. Tente de novo em instantes.", 503);
			if (error instanceof Sdk.AuthenticationError) throw new AppError("ASSISTANT_OFF", "A chave do assistente não foi aceita. Confira a configuração.", 503);
			if (error instanceof Sdk.APIError) throw new AppError("ASSISTANT_ERROR", "O assistente não respondeu agora. Tente de novo.", 502);
			throw error;
		}
		if (response.stop_reason === "refusal") throw new AppError("ASSISTANT_REFUSED", "O assistente não pode responder a esse pedido.", 422);
		return response.content.map((block) => block.type === "text" ? block.text : "").join("").trim() || "Não consegui responder agora. Tente perguntar de outro jeito.";
	};
}
// dist/auth.js
/** Acesso de teste (debug): com ele ligado, o token fixo entra como o usuário admin de teste. */
function withTestAccess(verify, enabled) {
	return async (token) => enabled && token === "praiamar-teste" ? {
		issuer: "praiamar:teste",
		subject: "admin",
		name: "admin"
	} : verify(token);
}
function tokenVerifier(options) {
	const getKey = options.getKey ?? createRemoteJWKSet(new URL(options.jwksUrl), { timeoutDuration: 5e3 });
	return async (token) => {
		const { payload } = await jwtVerify(token, getKey, {
			issuer: options.issuer,
			audience: options.audience,
			algorithms: ["RS256", "ES256"]
		});
		if (!payload.sub) throw Error("Token sem sujeito.");
		const name = typeof payload.email === "string" ? payload.email : void 0;
		return {
			issuer: options.issuer,
			subject: payload.sub,
			...name && { name }
		};
	};
}
// dist/edge.js
const env = (name) => Deno.env.get(name) ?? "";
async function restrictedUrl(base) {
	const secret = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default ?? env("SUPABASE_SERVICE_ROLE_KEY");
	const response = await fetch(base + "/rest/v1/rpc/praiamar_app_password", {
		method: "POST",
		headers: {
			apikey: secret,
			"content-type": "application/json"
		},
		body: "{}"
	});
	if (!response.ok) throw Error("Credencial do banco indisponível (" + response.status + ").");
	const url = new URL(env("SUPABASE_DB_URL"));
	const project = decodeURIComponent(url.username).split(".")[1];
	url.username = project ? "praiamar_app." + project : "praiamar_app";
	url.password = encodeURIComponent(await response.json());
	return url.toString();
}
async function createHandler() {
	const base = env("SUPABASE_URL");
	const app = await createApp({
		database: createDatabase(await restrictedUrl(base), 3),
		origins: (env("CORS_ORIGINS") || "https://megashooterx.github.io,http://127.0.0.1:5185,http://localhost:5185").split(",").map((origin) => origin.trim()),
		verifyToken: withTestAccess(tokenVerifier({
			issuer: base + "/auth/v1",
			audience: "authenticated",
			jwksUrl: base + "/auth/v1/.well-known/jwks.json"
		}), env("PRAIAMAR_TEST_ACCESS") !== "off"),
		assistant: createAssistant(env("ANTHROPIC_API_KEY") || void 0),
		fiscal: focusNfe({
			...env("FOCUS_NFE_TOKEN_HOMOLOGACAO") && { homologacao: env("FOCUS_NFE_TOKEN_HOMOLOGACAO") },
			...env("FOCUS_NFE_TOKEN_PRODUCAO") && { producao: env("FOCUS_NFE_TOKEN_PRODUCAO") }
		})
	});
	await app.ready();
	return async (request) => {
		const url = new URL(request.url);
		const reply = await app.inject({
			method: request.method,
			url: url.pathname.replace(/^(\/functions\/v1)?\/[^/]+/, "") + url.search,
			headers: Object.fromEntries(request.headers),
			...request.method !== "GET" && request.method !== "HEAD" && { payload: await request.text() },
			remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1"
		});
		const headers = new Headers();
		for (const [name, value] of Object.entries(reply.headers)) if (value !== void 0) for (const item of [value].flat()) headers.append(name, String(item));
		return new Response(reply.statusCode === 204 ? null : reply.payload, {
			status: reply.statusCode,
			headers
		});
	};
}
export { createHandler };
