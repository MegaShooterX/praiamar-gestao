import { ServerResponse } from "node:http";
import postgres from "postgres";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
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
	/** Venda por medida: unidade, metro, m², m³, hora, dia, kg, litro, chapa e caixa. */
	unit: z.enum([
		"un",
		"m",
		"m²",
		"m³",
		"h",
		"dia",
		"kg",
		"l",
		"chapa",
		"cx"
	]),
	costCents: MoneyCentsSchema,
	priceCents: MoneyCentsSchema,
	openingStockMilli: quantity,
	minStockMilli: quantity,
	/** Estoque máximo; sem ele, não há teto (a barra enche a partir de três vezes o mínimo). */
	maxStockMilli: quantity.refine((value) => BigInt(value) > 0n, "O máximo precisa ser positivo").optional(),
	active: z.boolean(),
	/** Classificação fiscal do item para a NF-e; sem ela, vale o NCM padrão dos dados fiscais. */
	ncm: z.string().regex(/^\d{8}$/).optional(),
	/** Código de barras (EAN, código do fornecedor): lido pela câmera para achar o item. */
	barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/, "Código de barras com 4 a 32 letras ou números.").optional()
});
/** Foto do item: já reduzida no aparelho (data URL de até ~300 kB), guardada à parte do estado comercial. */
const CatalogPhotoSchema = z.string().max(4e5, "A foto ficou grande demais.").regex(/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/, "Imagem inválida.");
z.record(z.uuid(), CatalogPhotoSchema);
const CatalogPhotoBodySchema = z.object({ image: CatalogPhotoSchema.nullable() }).strict();
/** Logo da empresa: a mesma regra de imagem das fotos do catálogo; nula quando não há. */
const CompanyLogoSchema = CatalogPhotoBodySchema;
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
/** Assinatura desenhada na tela: traços com pontos inteiros numa caixa de 300 × 100 ("x,y x,y|x,y ..."). */
const SignatureSchema = z.string().max(12e3).regex(/^(\d{1,3},\d{1,3}( \d{1,3},\d{1,3})*(\|\d{1,3},\d{1,3}( \d{1,3},\d{1,3})*)*)?$/).default("");
/** Cliente: contato para ligar e mandar mensagem, documento e endereço (preenchem a nota fiscal e a proposta). */
const CustomerSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(2).max(160),
	phone: z.string().trim().max(30).default(""),
	email: z.string().trim().max(120).default(""),
	document: z.string().regex(/^(\d{11}|\d{14})?$/, "Informe o CPF (11 números) ou o CNPJ (14 números).").default(""),
	street: z.string().trim().max(60).default(""),
	number: z.string().trim().max(60).default(""),
	district: z.string().trim().max(60).default(""),
	city: z.string().trim().max(60).default(""),
	uf: z.string().regex(/^([A-Z]{2})?$/).default(""),
	zip: z.string().regex(/^(\d{8})?$/).default(""),
	notes: z.string().trim().max(1e3).default(""),
	/** Assinatura do cliente colhida no aparelho; sai sobre a linha de aceite da proposta. */
	signature: SignatureSchema
});
/** Forma de pagamento da proposta: entrada (% do total, na aprovação) e o resto em parcelas mensais; vira o plano de
* parcelas do projeto quando o orçamento é aprovado. */
const PaymentPlanSchema = z.object({
	entryPercent: z.number().int().min(0).max(100),
	installments: z.number().int().min(0).max(36),
	method: z.enum([
		"Pix",
		"Transferência",
		"Cartão",
		"Dinheiro",
		"Boleto"
	])
});
const QuoteSchema = z.object({
	id: z.uuid(),
	code: z.string().min(1),
	title: z.string().trim().min(2).max(120),
	/** Vazio enquanto o cliente não foi informado: o orçamento pode começar só pelos itens. */
	customerName: z.string().trim().max(160),
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
	items: z.array(QuoteLineSchema).min(1).max(100),
	customerId: z.uuid().nullable().default(null),
	/** Anotação da equipe: aparece no sistema, nunca na proposta do cliente. */
	internalNotes: z.string().max(3e3).default(""),
	paymentPlan: PaymentPlanSchema.nullable().default(null),
	/** Dia de retornar ao cliente sobre a proposta (agenda e avisos do Hoje). */
	followUpOn: z.iso.date().nullable().default(null)
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
	]),
	/** Conta do caixa onde o dinheiro entrou (sem conta, recebimentos de antes das contas). */
	accountId: z.uuid().nullable().default(null)
});
/** Estorno de recebimento: o dinheiro voltou ao cliente (ou o recebimento foi lançado errado). O recebimento continua
* guardado; o estorno sai da mesma conta do caixa na data dele e o valor volta ao que falta receber. Um por recebimento. */
const PaymentReversalSchema = z.object({
	id: z.uuid(),
	paymentId: z.uuid(),
	reversedOn: z.iso.date(),
	reason: z.string().trim().min(5, "Escreva o motivo do estorno (pelo menos 5 letras).").max(300)
});
/** Cobrança sem orçamento (mensalidade, aluguel de equipamento, serviço avulso): vence numa data e entra no caixa
* quando recebida. Repetida todo mês, vira uma por mês. */
const ChargeSchema = z.object({
	id: z.uuid(),
	customerId: z.uuid().nullable().default(null),
	customerName: z.string().trim().min(2, "Informe de quem receber.").max(160),
	description: z.string().trim().min(2, "Descreva a cobrança.").max(160),
	amountCents: PositiveMoneySchema,
	dueOn: z.iso.date(),
	receivedOn: z.iso.date().nullable().default(null),
	method: CommercialPaymentSchema.shape.method.nullable().default(null),
	accountId: z.uuid().nullable().default(null)
});
/** Parcela a receber de um projeto (entrada, 1ª, 2ª...): o plano soma o valor do contrato; o que já entrou paga as
* parcelas na ordem do vencimento. */
const InstallmentSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	dueOn: z.iso.date(),
	amountCents: PositiveMoneySchema
});
/** Tarefa do projeto (checklist): o que fazer, quem faz, até quando e quando ficou pronta. */
const ProjectTaskSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	description: z.string().trim().min(2).max(200),
	responsible: z.string().trim().max(80).default(""),
	dueOn: z.iso.date().nullable().default(null),
	doneOn: z.iso.date().nullable().default(null)
});
/** Linha do tempo do projeto: anotação da equipe ou mudança de etapa (registrada sozinha ao mover). */
const ProjectNoteSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	kind: z.enum(["note", "stage"]),
	text: z.string().trim().min(1).max(2e3),
	createdOn: z.iso.date()
});
/** Fotos do projeto (medição, obra, montagem): várias por projeto, à parte do estado como as do catálogo. */
const ProjectPhotoSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	image: CatalogPhotoSchema
});
const OperatingExpenseSchema = z.object({
	id: z.uuid(),
	description: z.string(),
	category: z.string(),
	quoteId: z.uuid().nullable(),
	amountCents: PositiveMoneySchema,
	incurredOn: z.iso.date(),
	paidOn: z.iso.date().nullable(),
	/** Conta de onde saiu o pagamento. */
	accountId: z.uuid().nullable().default(null)
});
/** Conta do caixa (banco, dinheiro...): saldo inicial numa data; depois, o que entra e sai por ela. */
const CashAccountSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(2).max(60),
	openingCents: z.string().regex(/^-?\d{1,16}$/),
	openingOn: z.iso.date(),
	active: z.boolean().default(true)
});
/** Transferência entre contas do caixa (depositar o dinheiro do caixa no banco, sacar): sai de uma e entra na outra no
* mesmo dia; não é receita nem despesa. Não se edita: para desfazer, outra no sentido contrário. */
const CashTransferSchema = z.object({
	id: z.uuid(),
	fromAccountId: z.uuid(),
	toAccountId: z.uuid(),
	amountCents: PositiveMoneySchema,
	transferredOn: z.iso.date(),
	note: z.string().trim().max(300).default("")
});
const InventoryMovementSchema = z.object({
	id: z.uuid(),
	productId: z.uuid(),
	deltaMilli: z.string().regex(/^-?[1-9]\d{0,11}$/),
	reason: z.string().trim().min(5).max(300),
	occurredOn: z.iso.date(),
	/** Entrada de compra: de quem e por quanto a unidade (o custo do item vira o custo médio). */
	supplier: z.string().trim().min(1).max(120).optional(),
	unitCostCents: MoneyCentsSchema.optional(),
	/** Retirada para a obra (ou sobra devolvida dela): o custo da unidade no dia fica em unitCostCents. */
	projectId: z.uuid().optional()
});
/** Material separado para uma obra: sai do disponível (não do estoque) até ser retirado para ela. */
const MaterialReservationSchema = z.object({
	id: z.uuid(),
	projectId: z.uuid(),
	productId: z.uuid(),
	quantityMilli: quantity.refine((value) => BigInt(value) > 0n, "Quantidade deve ser positiva"),
	reservedOn: z.iso.date()
});
const GoalSchema = z.object({
	start: z.iso.date(),
	end: z.iso.date(),
	owner: z.string(),
	salesCents: PositiveMoneySchema,
	marginBasisPoints: z.number().int().min(0).max(1e4)
});
/** Recibo emitido: documento numerado e guardado (não se apaga nem se edita; para outra data, emite-se outro).
* "received": a empresa recebeu de alguém (cliente). "paid": alguém recebeu da empresa (funcionário, prestador). */
const ReceiptSchema = z.object({
	id: z.uuid(),
	/** Número sequencial da empresa: quem dá é o domínio ao aplicar o comando (no servidor vale o do servidor). */
	number: z.number().int().nonnegative(),
	kind: z.enum(["received", "paid"]).default("received"),
	issuedOn: z.iso.date(),
	party: z.string().trim().min(2).max(160),
	partyDocument: z.string().trim().max(20).default(""),
	customerId: z.uuid().nullable().default(null),
	employeeId: z.uuid().nullable().default(null),
	/** Valor líquido (o que a pessoa recebeu). */
	amountCents: PositiveMoneySchema,
	/** RPA: descontos sobre o bruto (INSS, ISS, IR...); bruto = líquido + descontos. */
	deductions: z.array(z.object({
		label: z.string().trim().min(2).max(30),
		amountCents: PositiveMoneySchema
	})).max(6).default([]),
	reference: z.string().trim().min(2).max(300),
	method: z.enum([
		"Pix",
		"Transferência",
		"Cartão",
		"Dinheiro",
		"Boleto",
		"Cheque",
		"Outro"
	]),
	/** Recebimento de projeto que o recibo comprova (um recibo por recebimento). */
	paymentId: z.uuid().nullable().default(null),
	notes: z.string().trim().max(1e3).default("")
});
/** Funcionário (registro de quem trabalha; o acesso ao sistema é a Equipe, à parte). */
const EmployeeSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(2).max(120),
	role: z.string().trim().max(60).default(""),
	phone: z.string().trim().max(30).default(""),
	document: z.string().trim().max(20).default(""),
	hiredOn: z.iso.date().nullable().default(null),
	contract: z.enum([
		"clt",
		"diarista",
		"autonomo"
	]).default("diarista"),
	/** Como ganha: por mês, por dia, por hora ou por empreita (valor combinado a cada serviço). */
	payBasis: z.enum([
		"month",
		"day",
		"hour",
		"job"
	]).default("day"),
	rateCents: MoneyCentsSchema.default("0"),
	pixKey: z.string().trim().max(120).default(""),
	active: z.boolean().default(true),
	notes: z.string().trim().max(1e3).default("")
});
/** Lançamento do funcionário. Somam ao que a empresa deve: trabalho (dias ou horas), salário e bônus. Abatem: desconto,
* vale e pagamento (vale e pagamento saem do caixa como despesa de mão de obra, com o mesmo id). */
const EmployeeEntrySchema = z.object({
	id: z.uuid(),
	employeeId: z.uuid(),
	kind: z.enum([
		"work",
		"salary",
		"bonus",
		"discount",
		"advance",
		"payment"
	]),
	date: z.iso.date(),
	/** Dias ou horas trabalhados, em milésimos (só no trabalho). */
	quantityMilli: z.string().regex(/^\d{1,12}$/).default("0"),
	amountCents: PositiveMoneySchema,
	projectId: z.uuid().nullable().default(null),
	note: z.string().trim().max(300).default(""),
	accountId: z.uuid().nullable().default(null)
});
/** Painel de controle: preferências de cada pessoa e padrões da empresa; o que faltar volta ao valor de fábrica. */
const UserSettingsSchema = z.object({
	/** Claro por padrão (08/11/2026); escuro ou automático (segue o aparelho) por escolha da pessoa. */
	theme: z.enum([
		"auto",
		"light",
		"dark"
	]).default("light"),
	largeText: z.boolean().default(false),
	/** Obras em quadro (por etapa) ou no calendário das entregas. A função escolhida antes (lens) não existe mais. */
	agenda: z.object({ view: z.enum(["board", "calendar"]).default("board") }).default({ view: "board" }),
	/** Orçamentos no computador: cartões ou tabela. */
	quoteView: z.enum(["cards", "table"]).default("cards")
});
const CompanySettingsSchema = z.object({
	quoteValidityDays: z.number().int().min(1).max(365).default(14),
	deliveryDays: z.number().int().min(1).max(730).default(42),
	/** Margem prevista abaixo desta aparece em alerta no orçamento. */
	minMarginPercent: z.number().int().min(0).max(90).default(25),
	defaultOwner: z.string().trim().max(80).default(""),
	/** Condições que já entram no orçamento novo (e saem na proposta do cliente). */
	quoteTerms: z.string().trim().max(3e3).default(""),
	paymentMethod: CommercialPaymentSchema.shape.method.default("Pix"),
	phone: z.string().trim().max(30).default(""),
	email: z.string().trim().max(120).default(""),
	address: z.string().trim().max(160).default(""),
	document: z.string().trim().max(20).default(""),
	site: z.string().trim().max(80).default(""),
	/** Quem é de vendas não vê custo nem margem: o servidor nem manda esses valores. */
	hideCostFromSales: z.boolean().default(false),
	pixKey: z.string().trim().max(77).default(""),
	pixName: z.string().trim().max(25).default(""),
	pixCity: z.string().trim().max(15).default(""),
	/** Modelo dos PDFs: clássico, com linhas (faixas leves na tabela) ou compacto (letra menor, sem fotos). */
	pdfModel: z.enum([
		"classic",
		"lines",
		"compact"
	]).default("classic"),
	pdfPhotos: z.boolean().default(true),
	pdfWatermark: z.boolean().default(false),
	/** Pix também no recibo de cliente (quando o recibo vai antes, como cobrança). */
	pdfReceiptPix: z.boolean().default(false),
	/** Campos personalizados no PDF (ex.: Garantia: 1 ano). */
	pdfFields: z.array(z.object({
		label: z.string().trim().min(1).max(30),
		value: z.string().trim().min(1).max(120)
	})).max(6).default([]),
	/** Assinatura da empresa (mesmo formato da do cliente). */
	signature: SignatureSchema
});
const SettingsSchema = z.object({
	user: UserSettingsSchema,
	company: CompanySettingsSchema,
	companyName: z.string()
});
/** Pessoa da equipe e o convite (código de uso único, vale 7 dias). */
const TeamMemberSchema = z.object({
	userId: z.uuid(),
	name: z.string(),
	role: z.enum([
		"admin",
		"manager",
		"sales",
		"production",
		"finance",
		"viewer"
	]),
	active: z.boolean(),
	/** A pessoa que está vendo a lista: o próprio acesso só outro administrador muda. */
	self: z.boolean().default(false)
});
const InviteSchema = z.object({
	code: z.string(),
	role: TeamMemberSchema.shape.role,
	expiresAt: z.string()
});
/** A proposta como o cliente vê pelo link: empresa, itens com preço e condições; nunca custo nem margem. */
const PublicProposalSchema = z.object({
	company: z.string(),
	contacts: z.object({
		phone: z.string(),
		email: z.string(),
		address: z.string(),
		document: z.string(),
		site: z.string()
	}),
	logo: z.string().nullable(),
	title: z.string(),
	customerName: z.string(),
	status: z.string(),
	revision: z.number(),
	createdOn: z.string(),
	validUntil: z.string(),
	dueDate: z.string(),
	discountCents: z.string(),
	shippingCents: z.string(),
	notes: z.string(),
	paymentPlan: PaymentPlanSchema.nullable(),
	items: z.array(z.object({
		description: z.string(),
		unit: z.string(),
		quantityMilli: z.string(),
		unitPriceCents: z.string()
	})),
	acceptedAt: z.string().nullable(),
	acceptedName: z.string().nullable(),
	/** Pix da empresa (vazio sem chave): o cliente paga pelo QR Code ou pelo copia e cola. */
	pix: z.object({
		key: z.string(),
		name: z.string(),
		city: z.string()
	}).nullable().default(null)
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
	reversals: z.array(PaymentReversalSchema).default([]),
	charges: z.array(ChargeSchema).default([]),
	reservations: z.array(MaterialReservationSchema).default([]),
	installments: z.array(InstallmentSchema).default([]),
	customers: z.array(CustomerSchema).default([]),
	accounts: z.array(CashAccountSchema).default([]),
	transfers: z.array(CashTransferSchema).default([]),
	tasks: z.array(ProjectTaskSchema).default([]),
	/** Aceites feitos pelo cliente no link da proposta (a equipe confere e aprova). */
	acceptances: z.array(z.object({
		quoteId: z.uuid(),
		acceptedOn: z.iso.date(),
		name: z.string(),
		revision: z.number().int()
	})).default([]),
	notes: z.array(ProjectNoteSchema).default([]),
	receipts: z.array(ReceiptSchema).default([]),
	employees: z.array(EmployeeSchema).default([]),
	employeeEntries: z.array(EmployeeEntrySchema).default([]),
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
/**
* O que um comando mudou, em vez da empresa inteira: registros novos ou alterados (upserts) e os que saíram (removes),
* por lista do estado. O aparelho aplica sobre o que já tem.
*/
const CommercialPatchSchema = z.object({
	upserts: z.record(z.string(), z.array(z.unknown())),
	removes: z.record(z.string(), z.array(z.string()))
});
/** Saldo inicial de verdade das contas do caixa que a janela do aparelho começa no primeiro dia dela. */
const FoldedAccountsSchema = z.record(z.string(), z.object({
	openingCents: z.string(),
	openingOn: z.string()
}));
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
		eventId: z.uuid(),
		installments: z.array(InstallmentSchema).max(60).optional()
	}),
	z.object({
		type: z.literal("amendQuote"),
		quote: QuoteSchema,
		projectId: z.uuid(),
		eventId: z.uuid(),
		reason: z.string().trim().min(5, "Escreva o motivo do aditivo (pelo menos 5 letras).").max(300)
	}),
	z.object({
		type: z.literal("saveCustomer"),
		customer: CustomerSchema
	}),
	z.object({
		type: z.literal("setFollowUp"),
		quoteId: z.uuid(),
		followUpOn: z.iso.date().nullable()
	}),
	z.object({
		type: z.literal("addPayment"),
		payment: CommercialPaymentSchema,
		expectedVersion: z.number().int().positive()
	}),
	z.object({
		type: z.literal("reversePayment"),
		reversal: PaymentReversalSchema
	}),
	z.object({
		type: z.literal("moveProject"),
		projectId: z.uuid(),
		stage: CommercialProjectSchema.shape.stage,
		expectedVersion: z.number().int().positive(),
		noteId: z.uuid().optional()
	}),
	z.object({
		type: z.literal("saveTask"),
		task: ProjectTaskSchema
	}),
	z.object({
		type: z.literal("deleteTask"),
		taskId: z.uuid()
	}),
	z.object({
		type: z.literal("addProjectNote"),
		note: ProjectNoteSchema
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
		paidOn: z.iso.date(),
		accountId: z.uuid().nullable().optional()
	}),
	z.object({
		type: z.literal("addCharge"),
		charge: ChargeSchema
	}),
	z.object({
		type: z.literal("receiveCharge"),
		chargeId: z.uuid(),
		receivedOn: z.iso.date(),
		method: CommercialPaymentSchema.shape.method,
		accountId: z.uuid().nullable()
	}),
	z.object({
		type: z.literal("deleteCharge"),
		chargeId: z.uuid()
	}),
	z.object({
		type: z.literal("reserveMaterial"),
		reservation: MaterialReservationSchema
	}),
	z.object({
		type: z.literal("releaseMaterial"),
		reservationId: z.uuid()
	}),
	z.object({
		type: z.literal("saveAccount"),
		account: CashAccountSchema
	}),
	z.object({
		type: z.literal("transferCash"),
		transfer: CashTransferSchema
	}),
	z.object({
		type: z.literal("saveGoal"),
		goal: GoalSchema
	}),
	z.object({
		type: z.literal("issueReceipt"),
		receipt: ReceiptSchema
	}),
	z.object({
		type: z.literal("saveEmployee"),
		employee: EmployeeSchema
	}),
	z.object({
		type: z.literal("addEmployeeEntry"),
		entry: EmployeeEntrySchema
	}),
	z.object({
		type: z.literal("deleteEmployeeEntry"),
		entryId: z.uuid()
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
const FiscalOverviewSchema = z.object({
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
const PaymentResultSchema = z.object({
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
const stageLabels = {
	quotation: "Orçamento",
	purchasing: "Compras",
	production: "Fabricação",
	installation: "Montagem",
	delivered: "Entregue",
	cancelled: "Cancelado"
};
/** Corpos que a API confere e o contrato descreve. */
const CreateCompanySchema = z.object({
	name: z.string().trim().min(2).max(160),
	example: DemoCommercialStateSchema.optional()
}).strict();
const PublicAcceptSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
const InviteAcceptSchema = z.object({ code: z.string().trim().min(6).max(20) }).strict();
const ProposalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{24,64}$/);
const json = (schema, io = "output") => {
	const { $schema: _, ...rest } = z.toJSONSchema(schema, {
		io,
		unrepresentable: "any"
	});
	return rest;
};
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const uuid = {
	type: "string",
	format: "uuid"
};
const pathId = (name = "id") => ({
	in: "path",
	name,
	required: true,
	schema: uuid
});
const object = (properties, required = Object.keys(properties)) => ({
	type: "object",
	required,
	properties
});
/**
* Uma operação: "company" pede o token e a empresa (x-company-id), "user" só o token e "public" nada. Os erros
* comuns (400, 429, 503 e os de acesso) entram sozinhos; `fails` acrescenta os da regra (404, 409...).
*/
function operation(summary, options = {}) {
	const access = options.access ?? "company";
	const company = access === "company" ? [{
		in: "header",
		name: "x-company-id",
		required: true,
		schema: uuid
	}] : [];
	const errors = [
		"400",
		...access === "public" ? [] : ["401"],
		...access === "company" ? ["403"] : [],
		...options.fails ?? [],
		"429",
		"503"
	];
	return {
		summary,
		...access !== "public" && { security: [{ bearer: [] }] },
		parameters: [...company, ...options.parameters ?? []],
		...options.body && { requestBody: {
			required: true,
			content: { "application/json": { schema: options.body } }
		} },
		responses: {
			[options.status ?? "200"]: {
				description: "Concluído",
				...options.result && { content: { "application/json": { schema: options.result } } }
			},
			...Object.fromEntries(errors.map((code) => [code, { $ref: `#/components/responses/${code}` }]))
		}
	};
}
let contract = null;
/** O contrato da API (OpenAPI 3.1), montado na primeira vez que é pedido: a função não paga isso ao abrir. */
function openApi() {
	if (contract) return contract;
	const idempotency = {
		in: "header",
		name: "idempotency-key",
		required: true,
		schema: json(IdempotencyKeySchema)
	};
	const token = {
		in: "path",
		name: "token",
		required: true,
		schema: json(ProposalTokenSchema)
	};
	const note = {
		result: json(FiscalDocumentSchema),
		fails: ["404", "409"]
	};
	const photo = json(CatalogPhotoBodySchema);
	contract = {
		openapi: "3.1.0",
		info: {
			title: "PraiaMar API",
			version: "0.2.0",
			description: "Dinheiro em string de centavos. Pedido com conta leva o token (Bearer); os da empresa, também o x-company-id. Repetir uma gravação é seguro: ids do aparelho, idempotency-key, commandId e eventId."
		},
		servers: [{ url: "http://127.0.0.1:3333" }],
		components: {
			securitySchemes: { bearer: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT"
			} },
			schemas: {
				Error: object({
					code: { type: "string" },
					message: { type: "string" },
					requestId: { type: "string" },
					issues: {
						type: "array",
						items: object({
							path: { type: "string" },
							message: { type: "string" }
						})
					}
				}, [
					"code",
					"message",
					"requestId"
				]),
				CommercialState: json(DemoCommercialStateSchema),
				CommercialCommand: json(CommercialCommandSchema, "input"),
				CommercialPatch: json(CommercialPatchSchema),
				CommercialWindow: object({
					state: ref("CommercialState"),
					folded: json(FoldedAccountsSchema)
				}),
				Project: json(ProjectSchema)
			},
			responses: Object.fromEntries([
				["400", "Campos inválidos (VALIDATION, com issues)"],
				["401", "Sem token ou sessão vencida"],
				["403", "Sem vínculo com a empresa ou a função não permite"],
				["404", "Não encontrado"],
				["409", "Conflito de versão, saldo, estado ou chave repetida"],
				["429", "Muitos pedidos; aguarde"],
				["503", "Banco ocupado ou serviço desligado; pode repetir"]
			].map(([code, description]) => [code, {
				description,
				content: { "application/json": { schema: ref("Error") } }
			}]))
		},
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
			"/openapi.json": { get: {
				summary: "Este contrato",
				responses: { "200": { description: "OpenAPI 3.1" } }
			} },
			"/v1/me": { get: operation("Empresas de quem entrou e, com state, os dados da empresa que o aparelho abre", {
				access: "user",
				parameters: [{
					in: "query",
					name: "state",
					schema: { enum: ["1", "window"] }
				}, {
					in: "query",
					name: "company",
					schema: { anyOf: [uuid, { const: "last" }] }
				}],
				result: object({
					companies: {
						type: "array",
						items: json(CompanySchema)
					},
					assistant: { type: "boolean" },
					state: ref("CommercialState"),
					folded: json(FoldedAccountsSchema),
					stateCompany: uuid
				}, ["companies", "assistant"])
			}) },
			"/v1/companies": { post: operation("Criar empresa (com os dados de exemplo, se vierem)", {
				access: "user",
				body: {
					...object({
						name: json(CreateCompanySchema.shape.name, "input"),
						example: ref("CommercialState")
					}, ["name"]),
					additionalProperties: false
				},
				status: "201",
				result: { allOf: [json(CompanySchema), object({ state: ref("CommercialState") }, [])] }
			}) },
			"/v1/commercial/state": { get: operation("Dados da empresa: o histórico inteiro ou, com window=1, o último mês e os saldos de antes", {
				parameters: [{
					in: "query",
					name: "window",
					schema: { const: "1" }
				}],
				result: { oneOf: [ref("CommercialState"), ref("CommercialWindow")] }
			}) },
			"/v1/commercial/commands": { post: operation("Gravar uma ação da tela (orçamento, recebimento, estoque, transferência...)", {
				parameters: [{
					in: "query",
					name: "reply",
					schema: { const: "patch" }
				}],
				body: ref("CommercialCommand"),
				result: { oneOf: [ref("CommercialState"), ref("CommercialPatch")] },
				fails: ["404", "409"]
			}) },
			"/v1/commercial/import": { post: operation("Importar os dados (planilha ou aparelho)", {
				body: ref("CommercialState"),
				result: ref("CommercialState"),
				fails: ["409"]
			}) },
			"/v1/settings": { get: operation("Preferências de quem entrou e padrões da empresa", { result: json(SettingsSchema) }) },
			"/v1/settings/user": { put: operation("Salvar as preferências de quem entrou", {
				body: json(UserSettingsSchema, "input"),
				result: json(UserSettingsSchema)
			}) },
			"/v1/settings/company": { put: operation("Salvar nome e padrões da empresa (administrador e gestor)", {
				body: json(CompanySettingsBodySchema, "input"),
				result: json(CompanySettingsBodySchema)
			}) },
			"/v1/quotes/{id}/link": { post: operation("Link da proposta para o cliente (vale 180 dias)", {
				parameters: [pathId()],
				status: "201",
				result: object({
					token: { type: "string" },
					expiresAt: {
						type: "string",
						format: "date-time"
					}
				}),
				fails: ["404", "409"]
			}) },
			"/v1/public/proposals/{token}": { get: operation("Proposta como o cliente vê pelo link, sem login (nunca custo nem margem)", {
				access: "public",
				parameters: [token],
				result: json(PublicProposalSchema),
				fails: ["404"]
			}) },
			"/v1/public/proposals/{token}/accept": { post: operation("O cliente aceita a proposta com o nome; a equipe aprova depois", {
				access: "public",
				parameters: [token],
				body: json(PublicAcceptSchema, "input"),
				result: object({ status: { type: "string" } }),
				fails: ["404", "409"]
			}) },
			"/v1/team": { get: operation("Pessoas da equipe", { result: {
				type: "array",
				items: json(TeamMemberSchema)
			} }) },
			"/v1/team/{userId}": { put: operation("Mudar a função ou desligar uma pessoa (administrador)", {
				parameters: [pathId("userId")],
				body: json(TeamMemberSchema.pick({
					role: true,
					active: true
				}).strict(), "input"),
				result: json(TeamMemberSchema.pick({
					userId: true,
					role: true,
					active: true
				})),
				fails: ["404", "409"]
			}) },
			"/v1/team/invites": { post: operation("Convite com código de uso único (vale 7 dias)", {
				body: json(TeamMemberSchema.pick({ role: true }).strict(), "input"),
				status: "201",
				result: json(InviteSchema)
			}) },
			"/v1/invites/accept": { post: operation("Entrar na empresa com o código do convite", {
				access: "user",
				body: json(InviteAcceptSchema, "input"),
				result: object({ companyId: uuid }),
				fails: ["404", "409"]
			}) },
			"/v1/company/logo": {
				get: operation("Logo da empresa", { result: photo }),
				put: operation("Trocar ou tirar o logo (administrador e gestor)", {
					body: json(CompanyLogoSchema, "input"),
					result: photo
				})
			},
			"/v1/projects/{id}/photos": {
				get: operation("Fotos da obra", {
					parameters: [pathId()],
					result: {
						type: "array",
						items: json(ProjectPhotoSchema)
					}
				}),
				post: operation("Acrescentar foto à obra", {
					parameters: [pathId()],
					body: json(ProjectPhotoSchema.omit({ projectId: true }), "input"),
					result: json(ProjectPhotoSchema),
					fails: ["404"]
				})
			},
			"/v1/projects/{id}/photos/{photo}": { delete: operation("Apagar foto da obra", {
				parameters: [pathId(), pathId("photo")],
				result: object({ id: uuid }),
				fails: ["404"]
			}) },
			"/v1/catalog/photos": { get: operation("Fotos do catálogo, por item", { result: {
				type: "object",
				additionalProperties: json(CatalogPhotoSchema)
			} }) },
			"/v1/catalog/{id}/photo": { put: operation("Trocar ou tirar a foto de um item do catálogo", {
				parameters: [pathId()],
				body: json(CatalogPhotoBodySchema, "input"),
				result: { allOf: [object({ itemId: uuid }), photo] },
				fails: ["404"]
			}) },
			"/v1/fiscal": { get: operation("Dados fiscais, notas da empresa e ambientes ligados no servidor", { result: { allOf: [json(FiscalOverviewSchema), object({ available: object({
				homologacao: { type: "boolean" },
				producao: { type: "boolean" }
			}) })] } }) },
			"/v1/fiscal/settings": { put: operation("Salvar os dados fiscais da empresa", {
				body: json(FiscalSettingsSchema, "input"),
				result: json(FiscalSettingsSchema)
			}) },
			"/v1/fiscal/nfe": { post: operation("Emitir NF-e dos produtos do orçamento aprovado", {
				body: json(NfeRequestSchema, "input"),
				status: "201",
				...note
			}) },
			"/v1/fiscal/nfse": { post: operation("Emitir NFS-e (padrão nacional) dos serviços do orçamento aprovado", {
				body: json(NfseRequestSchema, "input"),
				status: "201",
				...note
			}) },
			"/v1/fiscal/nfe/{id}/refresh": { post: operation("Consultar a situação da nota no provedor", {
				parameters: [pathId()],
				...note
			}) },
			"/v1/fiscal/nfe/{id}/cancel": { post: operation("Cancelar a nota com o motivo", {
				parameters: [pathId()],
				body: json(FiscalCancelSchema, "input"),
				...note
			}) },
			"/v1/fiscal/nfe/{id}/correction": { post: operation("Carta de correção da NF-e autorizada", {
				parameters: [pathId()],
				body: json(FiscalCorrectionRequestSchema, "input"),
				...note
			}) },
			"/v1/assistant": {
				get: operation("O assistente está ligado no servidor?", { result: object({ available: { type: "boolean" } }) }),
				post: operation("Pergunta ao assistente sobre os dados da empresa", {
					body: json(AssistantRequestSchema, "input"),
					result: object({ reply: { type: "string" } })
				})
			},
			"/v1/projects": {
				get: operation("Projetos com paginação por cursor", {
					parameters: [{
						in: "query",
						name: "limit",
						schema: {
							type: "integer",
							minimum: 1,
							maximum: 100,
							default: 25
						}
					}, {
						in: "query",
						name: "cursor",
						schema: {
							type: "string",
							maxLength: 512
						}
					}],
					result: object({
						items: {
							type: "array",
							items: ref("Project")
						},
						nextCursor: { type: ["string", "null"] }
					})
				}),
				post: operation("Cadastrar projeto", {
					parameters: [idempotency],
					body: json(CreateProjectSchema, "input"),
					status: "201",
					result: ref("Project"),
					fails: ["409"]
				})
			},
			"/v1/projects/{id}/payments": { post: operation("Registrar recebimento transacional", {
				parameters: [pathId(), idempotency],
				body: json(PaymentCommandSchema, "input"),
				status: "201",
				result: json(PaymentResultSchema),
				fails: ["404", "409"]
			}) },
			"/v1/projects/{id}/advance": { post: operation("Avançar etapa após conferências", {
				parameters: [pathId()],
				body: json(AdvanceCommandSchema, "input"),
				result: ref("Project"),
				fails: ["404", "409"]
			}) }
		}
	};
	return contract;
}
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
	if (input.barcode && state.products.some((item) => item.id !== input.id && item.barcode === input.barcode)) throw new AppError("CATALOG", "Outro item já usa este código de barras.", 409);
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
	if (movement.projectId) return moveForProject(state, movement, product);
	const stock = BigInt(stockMilli(state, product.id)), delta = BigInt(movement.deltaMilli);
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
/**
* Retirada de material para a obra (ou sobra devolvida dela): o custo da unidade no dia fica no movimento (vira o custo
* realizado da obra) e a retirada baixa a reserva do mesmo material na obra.
*/
function moveForProject(state, movement, product) {
	const project = state.projects.find((item) => item.id === movement.projectId);
	if (!project) throw new AppError("NOT_FOUND", "Obra não encontrada.", 404);
	if (movement.supplier !== void 0 || movement.unitCostCents !== void 0) throw new AppError("STOCK", "Fornecedor e custo são da compra, não da retirada para a obra.", 400);
	const taken = -BigInt(movement.deltaMilli);
	const reservation = state.reservations.find((item) => item.projectId === project.id && item.productId === product.id);
	const left = reservation ? BigInt(reservation.quantityMilli) - taken : 0n;
	return {
		...state,
		inventory: [InventoryMovementSchema.parse({
			...movement,
			unitCostCents: product.costCents
		}), ...state.inventory],
		reservations: !reservation || taken <= 0n ? state.reservations : left > 0n ? state.reservations.map((item) => item.id === reservation.id ? {
			...item,
			quantityMilli: left.toString()
		} : item) : state.reservations.filter((item) => item.id !== reservation.id)
	};
}
const activeProject = (state, projectId) => {
	const project = state.projects.find((item) => item.id === projectId);
	return !!project && !["delivered", "cancelled"].includes(project.stage);
};
/** Reserva de material para a obra (nova ou com a quantidade mudada): uma por material em cada obra. */
function reserveMaterial(state, input) {
	const reservation = MaterialReservationSchema.parse(input);
	const product = state.products.find((item) => item.id === reservation.productId);
	if (!product || product.kind === "service") throw new AppError("STOCK", "Selecione um produto ou material.", 400);
	if (!activeProject(state, reservation.projectId)) throw new AppError("PROJECT", "Só a obra em andamento reserva material.", 409);
	const same = state.reservations.find((item) => item.projectId === reservation.projectId && item.productId === reservation.productId);
	if (same && same.id !== reservation.id) throw new AppError("RESERVATION", "Esse material já está reservado para a obra: mude a quantidade dele.", 409);
	return {
		...state,
		reservations: same ? state.reservations.map((item) => item.id === reservation.id ? reservation : item) : [reservation, ...state.reservations]
	};
}
function releaseMaterial(state, reservationId) {
	if (!state.reservations.some((item) => item.id === reservationId)) return state;
	return {
		...state,
		reservations: state.reservations.filter((item) => item.id !== reservationId)
	};
}
function saveQuote(state, input, eventId) {
	if (state.versions.some((version) => version.id === eventId)) return state;
	const quote = QuoteSchema.parse(input);
	const previous = state.quotes.find((item) => item.id === quote.id);
	if (state.quotes.some((item) => item.id !== quote.id && item.code === quote.code)) throw new AppError("CODE", "Esse número de orçamento já está em uso.");
	if (previous?.status === "approved" || quote.status === "approved") throw new AppError("APPROVED_LOCK", "A proposta aprovada fica preservada. Duplique para uma nova negociação.");
	if (previous && previous.revision !== quote.revision) throw new AppError("VERSION_CONFLICT", "O orçamento mudou. Abra novamente antes de salvar.");
	if (quote.validUntil < quote.createdOn || quote.dueDate < quote.createdOn) throw new AppError("DATE", "Validade e prazo não podem ser anteriores à criação.", 400);
	if (quoteTotals(quote).totalCents === "0") throw new AppError("TOTAL", "O orçamento precisa ter um valor de venda positivo.", 400);
	if (quote.customerId && !state.customers.some((customer) => customer.id === quote.customerId)) throw new AppError("CUSTOMER", "Cliente não encontrado. Escolha de novo na lista.", 400);
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
function approveQuote(state, quoteId, revision, projectId, eventId, installments) {
	const quote = state.quotes.find((item) => item.id === quoteId);
	if (!quote) throw new AppError("NOT_FOUND", "Orçamento não encontrado.", 404);
	if (quote.status === "approved" && state.projects.some((project) => project.quoteId === quoteId)) return state;
	if (quote.revision !== revision) throw new AppError("VERSION_CONFLICT", "O orçamento mudou. Confira a revisão.");
	const approved = {
		...quote,
		status: "approved",
		approvedOn: state.referenceDate,
		followUpOn: null
	};
	const next = {
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
	return installments?.length ? planInstallments(next, projectId, installments) : next;
}
const dayMonth = (date) => date.slice(8, 10) + "/" + date.slice(5, 7);
/**
* Aditivo do contrato aprovado: itens e valores novos numa revisão nova, com o motivo na linha do tempo da obra. O
* contrato não fica abaixo do que já entrou (estorne antes). As parcelas acompanham: o que aumentou vira uma parcela
* nova (no vencimento da última, ou hoje); o que diminuiu sai das parcelas em aberto, da última para a primeira.
*/
function amendQuote(state, input, projectId, eventId, reason) {
	if (state.versions.some((version) => version.id === eventId)) return state;
	const parsed = QuoteSchema.parse(input);
	const previous = state.quotes.find((item) => item.id === parsed.id);
	if (!previous || previous.status !== "approved") throw new AppError("AMEND", "O aditivo é do contrato aprovado.", 409);
	const project = state.projects.find((item) => item.id === projectId && item.quoteId === previous.id);
	if (!project || project.stage === "cancelled") throw new AppError("AMEND", "A obra cancelada não recebe aditivo.", 409);
	if (previous.revision !== parsed.revision) throw new AppError("VERSION_CONFLICT", "O contrato mudou. Abra novamente antes do aditivo.");
	if (parsed.customerId && !state.customers.some((customer) => customer.id === parsed.customerId)) throw new AppError("CUSTOMER", "Cliente não encontrado. Escolha de novo na lista.", 400);
	const amended = {
		...parsed,
		code: previous.code,
		createdOn: previous.createdOn,
		status: "approved",
		approvedOn: previous.approvedOn,
		revision: previous.revision + 1,
		followUpOn: null
	};
	if (amended.dueDate < amended.createdOn) throw new AppError("DATE", "A entrega não pode ser antes da criação do orçamento.", 400);
	const before = BigInt(quoteTotals(previous).totalCents), after = BigInt(quoteTotals(amended).totalCents), received = BigInt(receivedForProject(state, project.id));
	if (after <= 0n) throw new AppError("TOTAL", "O contrato precisa ter um valor positivo.", 400);
	if (after < received) throw new AppError("AMEND", "O contrato não pode ficar abaixo do que já foi recebido (" + formatMoney(received.toString()) + "). Estorne antes.", 409);
	const text = reason.trim();
	const next = {
		...state,
		quotes: state.quotes.map((item) => item.id === amended.id ? amended : item),
		projects: state.projects.map((item) => item.id === project.id ? {
			...item,
			version: item.version + 1,
			dueDate: amended.dueDate
		} : item),
		versions: [{
			id: eventId,
			quoteId: amended.id,
			revision: amended.revision,
			snapshot: copyQuote(amended),
			reason: "Aditivo: " + text,
			createdOn: state.referenceDate
		}, ...state.versions],
		notes: [{
			id: eventId,
			projectId: project.id,
			kind: "note",
			text: "Aditivo: " + text + " · contrato de " + formatMoney(before.toString()) + " para " + formatMoney(after.toString()),
			createdOn: state.referenceDate
		}, ...state.notes]
	};
	const plan = installmentStatus(state, project.id);
	if (!plan.length || after === before) return next;
	let installments = plan.map(({ id, projectId, dueOn, amountCents }) => ({
		id,
		projectId,
		dueOn,
		amountCents
	}));
	if (after > before) {
		const last = plan.at(-1).dueOn;
		installments.push({
			id: eventId,
			projectId: project.id,
			dueOn: last > state.referenceDate ? last : state.referenceDate,
			amountCents: (after - before).toString()
		});
	} else {
		let cut = before - after;
		for (let index = plan.length - 1; index >= 0 && cut > 0n; index--) {
			const item = plan[index], open = BigInt(item.amountCents) - BigInt(item.paidCents), taken = open < cut ? open : cut;
			cut -= taken;
			installments[index] = {
				...installments[index],
				amountCents: (BigInt(item.amountCents) - taken).toString()
			};
		}
		installments = installments.filter((item) => item.amountCents !== "0");
	}
	return planInstallments(next, project.id, installments);
}
/** Cadastro do cliente: novo ou atualizado pelo id; o nome continua nas propostas antigas como foi escrito. */
function saveCustomer(state, input) {
	const customer = CustomerSchema.parse(input);
	const previous = state.customers.find((item) => item.id === customer.id);
	return {
		...state,
		customers: previous ? state.customers.map((item) => item.id === customer.id ? customer : item) : [customer, ...state.customers]
	};
}
/** Data de retornar ao cliente sobre a proposta em aberto; aprovada ou não fechada não tem retorno. */
function setFollowUp(state, quoteId, followUpOn) {
	const quote = state.quotes.find((item) => item.id === quoteId);
	if (!quote) throw new AppError("NOT_FOUND", "Orçamento não encontrado.", 404);
	if (quote.status === "approved" || quote.status === "lost") throw new AppError("FOLLOW_UP", "Só a proposta em aberto tem retorno marcado.");
	if (quote.followUpOn === followUpOn) return state;
	return {
		...state,
		quotes: state.quotes.map((item) => item.id === quoteId ? {
			...item,
			followUpOn
		} : item)
	};
}
/** Recebimentos estornados: ficam guardados, mas não contam. */
const reversedIds = (state) => new Set(state.reversals.map((item) => item.paymentId));
function receivedForProject(state, projectId) {
	const reversed = reversedIds(state);
	return sum(state.payments.filter((payment) => payment.projectId === projectId && !reversed.has(payment.id)).map((payment) => payment.amountCents)).toString();
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
	if (payment.accountId && !state.accounts.some((account) => account.id === payment.accountId)) throw new AppError("ACCOUNT", "Conta do caixa não encontrada.", 400);
	return {
		...state,
		payments: [payment, ...state.payments],
		projects: state.projects.map((item) => item.id === project.id ? {
			...item,
			version: item.version + 1
		} : item)
	};
}
/**
* Estorno de um recebimento: o dinheiro sai da conta em que entrou, na data do estorno, e o valor volta ao que falta
* receber da obra. O recebimento continua guardado; repetir o envio não estorna duas vezes.
*/
function reversePayment(state, input) {
	const reversal = PaymentReversalSchema.parse(input);
	if (state.reversals.some((item) => item.id === reversal.id)) return state;
	const payment = state.payments.find((item) => item.id === reversal.paymentId);
	if (!payment) throw new AppError("NOT_FOUND", "Recebimento não encontrado.", 404);
	if (state.reversals.some((item) => item.paymentId === payment.id)) throw new AppError("REVERSAL", "Este recebimento já foi estornado.", 409);
	if (reversal.reversedOn < payment.receivedOn) throw new AppError("DATE", "O estorno não pode ser antes do recebimento.", 400);
	if (reversal.reversedOn > state.referenceDate) throw new AppError("DATE", "O estorno não pode ter data no futuro.", 400);
	return {
		...state,
		reversals: [reversal, ...state.reversals],
		projects: state.projects.map((item) => item.id === payment.projectId ? {
			...item,
			version: item.version + 1
		} : item),
		notes: [{
			id: reversal.id,
			projectId: payment.projectId,
			kind: "note",
			text: "Estorno de " + formatMoney(payment.amountCents) + " recebido em " + dayMonth(payment.receivedOn) + ": " + reversal.reason,
			createdOn: reversal.reversedOn
		}, ...state.notes]
	};
}
/** Muda a etapa do projeto; a mesma etapa não muda nada. Com dinheiro recebido não cancela: estorne antes. */
function moveProjectStage(state, projectId, stage, expectedVersion, noteId) {
	const project = state.projects.find((item) => item.id === projectId);
	if (!project) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
	if (project.stage === stage) return state;
	if (project.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "O projeto mudou. Atualize antes de mover.");
	if (stage === "cancelled" && BigInt(receivedForProject(state, projectId)) > 0n) throw new AppError("PROJECT", "A obra tem dinheiro recebido: estorne os recebimentos antes de cancelar.");
	return {
		...state,
		projects: state.projects.map((item) => item.id === projectId ? {
			...item,
			stage,
			version: item.version + 1
		} : item),
		notes: noteId ? [{
			id: noteId,
			projectId,
			kind: "stage",
			text: stageLabels[stage],
			createdOn: state.referenceDate
		}, ...state.notes] : state.notes
	};
}
const projectOf = (state, projectId) => {
	if (!state.projects.some((item) => item.id === projectId)) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
};
/** Tarefa do checklist do projeto: nova ou atualizada (texto, responsável, prazo, feita ou não). */
function saveTask(state, input) {
	const task = ProjectTaskSchema.parse(input);
	projectOf(state, task.projectId);
	if (task.doneOn && task.doneOn > state.referenceDate) throw new AppError("DATE", "A tarefa não pode ficar pronta no futuro.", 400);
	const previous = state.tasks.find((item) => item.id === task.id);
	if (previous && previous.projectId !== task.projectId) throw new AppError("TASK", "A tarefa é de outro projeto.", 400);
	return {
		...state,
		tasks: previous ? state.tasks.map((item) => item.id === task.id ? task : item) : [...state.tasks, task]
	};
}
function deleteTask(state, taskId) {
	if (!state.tasks.some((item) => item.id === taskId)) return state;
	return {
		...state,
		tasks: state.tasks.filter((item) => item.id !== taskId)
	};
}
/** Anotação na linha do tempo do projeto; repetida (mesmo id), não duplica. */
function addProjectNote(state, input) {
	const note = ProjectNoteSchema.parse(input);
	projectOf(state, note.projectId);
	if (state.notes.some((item) => item.id === note.id)) return state;
	return {
		...state,
		notes: [note, ...state.notes]
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
/** Situação de cada parcela: o recebido do projeto quita as parcelas na ordem do vencimento. */
function installmentStatus(state, projectId) {
	const plan = state.installments.filter((item) => item.projectId === projectId).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
	let left = BigInt(receivedForProject(state, projectId));
	return plan.map((item, index) => {
		const amount = BigInt(item.amountCents), paid = left < amount ? left : amount;
		left -= paid;
		return {
			...item,
			number: index + 1,
			of: plan.length,
			paidCents: paid.toString(),
			status: paid === amount ? "paid" : item.dueOn < state.referenceDate ? "overdue" : "open"
		};
	});
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
function payOperatingExpense(state, expenseId, paidOn, accountId = null) {
	const expense = state.expenses.find((item) => item.id === expenseId);
	if (!expense) throw new AppError("NOT_FOUND", "Despesa não encontrada.", 404);
	if (expense.paidOn) return state;
	if (paidOn > state.referenceDate) throw new AppError("DATE", "A data do pagamento não pode estar no futuro.", 400);
	if (accountId && !state.accounts.some((account) => account.id === accountId)) throw new AppError("ACCOUNT", "Conta do caixa não encontrada.", 400);
	return {
		...state,
		expenses: state.expenses.map((item) => item.id === expenseId ? {
			...item,
			paidOn,
			accountId
		} : item)
	};
}
/** Cobrança sem orçamento nova (uma por mês quando se repete); repetida com o mesmo id, não duplica. */
function addCharge(state, input) {
	const charge = ChargeSchema.parse(input);
	if (state.charges.some((item) => item.id === charge.id)) return state;
	if (charge.receivedOn) throw new AppError("CHARGE", "Lance a cobrança e depois marque recebida.", 400);
	if (charge.customerId && !state.customers.some((item) => item.id === charge.customerId)) throw new AppError("CUSTOMER", "Cliente não encontrado. Escolha de novo na lista.", 400);
	return {
		...state,
		charges: [charge, ...state.charges]
	};
}
/** Cobrança recebida: entra no caixa na data e na conta informadas; já recebida, fica como está. */
function receiveCharge(state, chargeId, receivedOn, method, accountId) {
	const charge = state.charges.find((item) => item.id === chargeId);
	if (!charge) throw new AppError("NOT_FOUND", "Cobrança não encontrada.", 404);
	if (charge.receivedOn) return state;
	if (receivedOn > state.referenceDate) throw new AppError("DATE", "A data do recebimento não pode estar no futuro.", 400);
	if (accountId && !state.accounts.some((account) => account.id === accountId)) throw new AppError("ACCOUNT", "Conta do caixa não encontrada.", 400);
	return {
		...state,
		charges: state.charges.map((item) => item.id === chargeId ? {
			...item,
			receivedOn,
			method,
			accountId
		} : item)
	};
}
function deleteCharge(state, chargeId) {
	const charge = state.charges.find((item) => item.id === chargeId);
	if (!charge) return state;
	if (charge.receivedOn) throw new AppError("CHARGE", "A cobrança já recebida fica guardada.", 409);
	return {
		...state,
		charges: state.charges.filter((item) => item.id !== chargeId)
	};
}
/** Conta do caixa: nova ou atualizada (nome, saldo inicial, data, ativa). */
function saveAccount(state, input) {
	const account = CashAccountSchema.parse(input);
	const previous = state.accounts.some((item) => item.id === account.id);
	return {
		...state,
		accounts: previous ? state.accounts.map((item) => item.id === account.id ? account : item) : [...state.accounts, account]
	};
}
/** Saldo da conta: o inicial mais o que entrou e menos o que saiu por ela desde a data do saldo inicial. */
/** Transferência entre contas do caixa: contas diferentes que existem e data que não é futura; a conta de origem pode
* ficar negativa (a tela avisa). Repetir o envio não duplica. */
function transferCash(state, input) {
	const transfer = CashTransferSchema.parse(input);
	if (state.transfers.some((item) => item.id === transfer.id)) return state;
	if (transfer.fromAccountId === transfer.toAccountId) throw new AppError("TRANSFER", "Escolha duas contas diferentes.", 400);
	if (![transfer.fromAccountId, transfer.toAccountId].every((id) => state.accounts.some((account) => account.id === id))) throw new AppError("ACCOUNT", "Conta do caixa não encontrada.", 400);
	if (transfer.transferredOn > state.referenceDate) throw new AppError("DATE", "A transferência não pode ter data no futuro.", 400);
	return {
		...state,
		transfers: [transfer, ...state.transfers]
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
/** Recibo novo com o próximo número da empresa. O mesmo id de novo não duplica; um recebimento tem um recibo só. */
function issueReceipt(state, input) {
	const receipt = ReceiptSchema.parse(input);
	if (state.receipts.some((item) => item.id === receipt.id)) return state;
	if (receipt.paymentId) {
		const payment = state.payments.find((item) => item.id === receipt.paymentId);
		if (!payment) throw new AppError("NOT_FOUND", "Recebimento não encontrado.", 404);
		if (state.receipts.some((item) => item.paymentId === receipt.paymentId)) throw new AppError("RECEIPT", "Este recebimento já tem recibo.", 409);
		if (payment.amountCents !== receipt.amountCents) throw new AppError("RECEIPT", "O recibo precisa ter o valor do recebimento.", 400);
	}
	if (receipt.deductions.length && receipt.kind !== "paid") throw new AppError("RECEIPT", "Descontos (INSS, ISS...) só no recibo de quem a empresa pagou.", 400);
	if (receipt.employeeId && !state.employees.some((item) => item.id === receipt.employeeId)) throw new AppError("NOT_FOUND", "Funcionário não encontrado.", 404);
	if (receipt.issuedOn > state.referenceDate) throw new AppError("DATE", "O recibo não pode ter data no futuro.", 400);
	const number = state.receipts.reduce((top, item) => Math.max(top, item.number), 0) + 1;
	return {
		...state,
		receipts: [{
			...receipt,
			number
		}, ...state.receipts]
	};
}
/** Funcionário novo ou atualizado. */
function saveEmployee(state, input) {
	const employee = EmployeeSchema.parse(input);
	const previous = state.employees.some((item) => item.id === employee.id);
	return {
		...state,
		employees: previous ? state.employees.map((item) => item.id === employee.id ? employee : item) : [...state.employees, employee]
	};
}
const employeeCash = /* @__PURE__ */ new Set(["advance", "payment"]);
const employeeEntryLabels = {
	work: "Trabalho",
	salary: "Salário",
	bonus: "Bônus",
	discount: "Desconto",
	advance: "Vale",
	payment: "Pagamento"
};
/** Lançamento do funcionário. Vale e pagamento saem do caixa: viram despesa paga de mão de obra com o mesmo id. */
function addEmployeeEntry(state, input) {
	const entry = EmployeeEntrySchema.parse(input);
	if (state.employeeEntries.some((item) => item.id === entry.id)) return state;
	const employee = state.employees.find((item) => item.id === entry.employeeId);
	if (!employee) throw new AppError("NOT_FOUND", "Funcionário não encontrado.", 404);
	if (entry.date > state.referenceDate) throw new AppError("DATE", "O lançamento não pode ter data no futuro.", 400);
	if (entry.projectId) projectOf(state, entry.projectId);
	if (entry.accountId && !state.accounts.some((account) => account.id === entry.accountId)) throw new AppError("ACCOUNT", "Conta do caixa não encontrada.", 400);
	if (entry.kind === "work" && BigInt(entry.quantityMilli) <= 0n) throw new AppError("EMPLOYEE", "Informe quantos dias ou horas.", 400);
	const next = {
		...state,
		employeeEntries: [entry, ...state.employeeEntries]
	};
	if (!employeeCash.has(entry.kind)) return next;
	const quoteId = state.projects.find((item) => item.id === entry.projectId)?.quoteId ?? null;
	return {
		...next,
		expenses: [{
			id: entry.id,
			description: employeeEntryLabels[entry.kind] + " · " + employee.name + (entry.note ? " · " + entry.note : ""),
			category: "Mão de obra",
			quoteId,
			amountCents: entry.amountCents,
			incurredOn: entry.date,
			paidOn: entry.date,
			accountId: entry.accountId
		}, ...state.expenses]
	};
}
/** Apaga trabalho, salário, bônus ou desconto lançado errado; vale e pagamento já saíram do caixa e ficam. */
function deleteEmployeeEntry(state, entryId) {
	const entry = state.employeeEntries.find((item) => item.id === entryId);
	if (!entry) return state;
	if (employeeCash.has(entry.kind)) throw new AppError("EMPLOYEE", "Vale e pagamento já saíram do caixa e não se apagam.", 409);
	return {
		...state,
		employeeEntries: state.employeeEntries.filter((item) => item.id !== entryId)
	};
}
const roleNames = {
	admin: "Administrador",
	manager: "Gestor",
	sales: "Vendas",
	production: "Produção",
	finance: "Financeiro",
	viewer: "Só consulta"
};
/**
* O que cada função grava (administrador e gestor gravam tudo; só consulta, nada). Vendas: clientes, orçamentos,
* aprovação, catálogo e o que o cliente pagou; produção: etapas, tarefas, anotações, estoque e dias de trabalho;
* financeiro: recebimentos, despesas, contas, parcelas, recibos e funcionários. A tela esconde o que a função não faz
* e o servidor confere do mesmo jeito.
*/
const commandRoles = {
	saveCatalogItem: ["sales"],
	moveInventory: ["production", "finance"],
	saveQuote: ["sales"],
	approveQuote: ["sales"],
	saveCustomer: ["sales", "finance"],
	setFollowUp: ["sales"],
	amendQuote: ["sales"],
	addPayment: ["sales", "finance"],
	reversePayment: ["finance"],
	moveProject: ["production"],
	saveTask: ["sales", "production"],
	deleteTask: ["sales", "production"],
	addProjectNote: [
		"sales",
		"production",
		"finance"
	],
	planInstallments: ["sales", "finance"],
	addExpense: ["finance"],
	payExpense: ["finance"],
	addCharge: ["sales", "finance"],
	receiveCharge: ["sales", "finance"],
	deleteCharge: ["sales", "finance"],
	reserveMaterial: ["production"],
	releaseMaterial: ["production"],
	saveAccount: ["finance"],
	transferCash: ["finance"],
	saveGoal: [],
	issueReceipt: ["sales", "finance"],
	saveEmployee: ["finance"],
	addEmployeeEntry: ["production", "finance"],
	deleteEmployeeEntry: ["finance"]
};
const commandActions = {
	saveCatalogItem: "mudar o catálogo",
	moveInventory: "movimentar o estoque",
	saveQuote: "fazer ou mudar orçamento",
	approveQuote: "aprovar orçamento",
	saveCustomer: "cadastrar cliente",
	setFollowUp: "marcar retorno ao cliente",
	amendQuote: "fazer aditivo do contrato",
	addPayment: "registrar recebimento",
	reversePayment: "estornar recebimento",
	moveProject: "mudar a etapa da obra",
	saveTask: "mexer nas tarefas da obra",
	deleteTask: "apagar tarefa da obra",
	addProjectNote: "anotar na obra",
	planInstallments: "mudar as parcelas",
	addExpense: "lançar despesa",
	payExpense: "pagar despesa",
	addCharge: "lançar cobrança",
	receiveCharge: "receber cobrança",
	deleteCharge: "apagar cobrança",
	reserveMaterial: "reservar material para a obra",
	releaseMaterial: "tirar a reserva de material",
	saveAccount: "mudar conta do caixa",
	transferCash: "transferir entre contas do caixa",
	saveGoal: "mudar as metas",
	issueReceipt: "emitir esse recibo",
	saveEmployee: "cadastrar funcionário",
	addEmployeeEntry: "lançar isso para o funcionário",
	deleteEmployeeEntry: "apagar lançamento do funcionário"
};
/** Se a função pode gravar o comando (ou o tipo de comando, para mostrar ou esconder o botão). */
function canRun(role, command) {
	if (role === "admin" || role === "manager") return true;
	const type = typeof command === "string" ? command : command.type;
	if (!commandRoles[type].includes(role)) return false;
	if (typeof command === "string") return true;
	if (command.type === "issueReceipt" && role === "sales") return command.receipt.kind !== "paid";
	if (command.type === "addEmployeeEntry" && role === "production") return command.entry.kind === "work";
	return true;
}
function forbiddenMessage(role, command) {
	const type = typeof command === "string" ? command : command.type;
	return "A função " + roleNames[role] + " não permite " + commandActions[type] + ". Peça a quem administra a equipe.";
}
/** Primeiro dia da janela do aparelho e o dia antes dele, onde ficam as linhas de "saldo anterior". */
function windowDates(referenceDate, days = 31) {
	const since = (/* @__PURE__ */ new Date(Date.parse(referenceDate + "T12:00:00Z") - days * 864e5)).toISOString().slice(0, 10);
	return {
		since,
		before: (/* @__PURE__ */ new Date(Date.parse(since + "T12:00:00Z") - 864e5)).toISOString().slice(0, 10)
	};
}
/**
* Fecha a janela com o que vinha de antes: a conta do caixa começa no saldo do primeiro dia (o saldo inicial de verdade
* volta em folded) e estoque e funcionários ganham uma linha de "Saldo anterior". O estado chega só com as linhas da
* janela: recortado no aparelho (deviceWindow) ou lido assim do banco (a API).
*/
function foldWindow(state, opening, { since, before }) {
	const folded = {};
	const accounts = state.accounts.map((account) => {
		if (account.openingOn >= since) return account;
		folded[account.id] = {
			openingCents: account.openingCents,
			openingOn: account.openingOn
		};
		return {
			...account,
			openingCents: BigInt(opening.accounts[account.id] ?? account.openingCents).toString(),
			openingOn: since
		};
	});
	const inventory = [...state.inventory, ...Object.entries(opening.stock).flatMap(([productId, value]) => {
		const delta = BigInt(value);
		return delta === 0n ? [] : [{
			id: "00000000-0000-4000-8000-" + productId.slice(-12),
			productId,
			deltaMilli: delta.toString(),
			reason: "Saldo anterior",
			occurredOn: before
		}];
	})];
	const employeeEntries = [...state.employeeEntries, ...Object.entries(opening.owed).flatMap(([employeeId, value]) => {
		const owed = BigInt(value);
		return owed === 0n ? [] : [{
			id: "00000000-0000-4000-9000-" + employeeId.slice(-12),
			employeeId,
			kind: owed > 0n ? "salary" : "discount",
			date: before,
			quantityMilli: "0",
			amountCents: (owed > 0n ? owed : -owed).toString(),
			projectId: null,
			note: "Saldo anterior",
			accountId: null
		}];
	})];
	return {
		folded,
		state: {
			...state,
			accounts,
			inventory,
			employeeEntries
		}
	};
}
/** Identidade de um registro na sua lista do estado (meta e aceite do cliente não têm id próprio). */
const identity = (key, item) => {
	const row = item;
	return key === "goals" ? String(row.start) + "|" + String(row.end) + "|" + String(row.owner) : key === "acceptances" ? String(row.quoteId) : String(row.id);
};
/** O que mudou de um estado para o outro (só as listas que o comando tocou). */
function diffStates(before, after) {
	const patch = {
		upserts: {},
		removes: {}
	};
	for (const [key, next] of Object.entries(after)) {
		const previous = before[key];
		if (!Array.isArray(next) || !Array.isArray(previous) || next === previous) continue;
		const old = new Map(previous.map((item) => [identity(key, item), JSON.stringify(item)]));
		const seen = /* @__PURE__ */ new Set();
		const upserts = next.filter((item) => {
			const id = identity(key, item);
			seen.add(id);
			return old.get(id) !== JSON.stringify(item);
		});
		const removes = [...old.keys()].filter((id) => !seen.has(id));
		if (upserts.length) patch.upserts[key] = upserts;
		if (removes.length) patch.removes[key] = removes;
	}
	return patch;
}
/** Ponto único das alterações: a tela (na hora) e a API (na transação) aplicam o mesmo comando. */
function applyCommercialCommand(state, command) {
	switch (command.type) {
		case "saveCatalogItem": return saveCatalogItem(state, command.item);
		case "moveInventory": return moveInventory(state, command.movement);
		case "saveQuote": return saveQuote(state, command.quote, command.eventId);
		case "approveQuote": return approveQuote(state, command.quoteId, command.revision, command.projectId, command.eventId, command.installments);
		case "amendQuote": return amendQuote(state, command.quote, command.projectId, command.eventId, command.reason);
		case "saveCustomer": return saveCustomer(state, command.customer);
		case "setFollowUp": return setFollowUp(state, command.quoteId, command.followUpOn);
		case "addPayment": return addCommercialPayment(state, command.payment, command.expectedVersion);
		case "reversePayment": return reversePayment(state, command.reversal);
		case "moveProject": return moveProjectStage(state, command.projectId, command.stage, command.expectedVersion, command.noteId);
		case "saveTask": return saveTask(state, command.task);
		case "deleteTask": return deleteTask(state, command.taskId);
		case "addProjectNote": return addProjectNote(state, command.note);
		case "planInstallments": return planInstallments(state, command.projectId, command.installments);
		case "addExpense": return addOperatingExpense(state, command.expense);
		case "payExpense": return payOperatingExpense(state, command.expenseId, command.paidOn, command.accountId ?? null);
		case "addCharge": return addCharge(state, command.charge);
		case "receiveCharge": return receiveCharge(state, command.chargeId, command.receivedOn, command.method, command.accountId);
		case "deleteCharge": return deleteCharge(state, command.chargeId);
		case "reserveMaterial": return reserveMaterial(state, command.reservation);
		case "releaseMaterial": return releaseMaterial(state, command.reservationId);
		case "saveAccount": return saveAccount(state, command.account);
		case "transferCash": return transferCash(state, command.transfer);
		case "saveGoal": return saveGoal(state, command.goal);
		case "issueReceipt": return issueReceipt(state, command.receipt);
		case "saveEmployee": return saveEmployee(state, command.employee);
		case "addEmployeeEntry": return addEmployeeEntry(state, command.entry);
		case "deleteEmployeeEntry": return deleteEmployeeEntry(state, command.entryId);
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
	const everyone = filter.owner === "all";
	const charges = everyone ? state.charges.filter((item) => between(item.dueOn, filter.start, filter.end)) : [];
	const chargesIn = everyone ? state.charges.filter((item) => between(item.receivedOn, filter.start, filter.end)).map((item) => item.amountCents) : [];
	const reversedOut = state.reversals.filter((item) => between(item.reversedOn, filter.start, filter.end)).flatMap((item) => {
		const payment = state.payments.find((row) => row.id === item.paymentId);
		return payment && visibleOwner(state.projects.find((project) => project.id === payment.projectId)?.quoteId ?? null) ? [payment.amountCents] : [];
	});
	const paidExpenses = state.expenses.filter((expense) => between(expense.paidOn, filter.start, filter.end) && visibleOwner(expense.quoteId));
	const sales = sum(approved.map((quote) => quoteTotals(quote).totalCents)), cost = sum(approved.map((quote) => quoteTotals(quote).costCents));
	const expense = sum(expenses.map((item) => item.amountCents)), cashIn = sum(payments.map((item) => item.amountCents)) + sum(chargesIn) - sum(reversedOut), otherIncome = sum(charges.map((item) => item.amountCents)), cashOut = sum(paidExpenses.map((item) => item.amountCents));
	const cohort = state.quotes.filter((quote) => between(quote.createdOn, filter.start, filter.end) && (filter.owner === "all" || quote.owner === filter.owner));
	const eligible = cohort.filter((quote) => quote.status !== "draft");
	const won = eligible.filter((quote) => quote.status === "approved");
	const approvedIds = new Set(approved.map((quote) => quote.id));
	const reversed = reversedIds(state);
	const receivedCohort = sum(state.payments.filter((payment) => !reversed.has(payment.id) && approvedIds.has(state.projects.find((project) => project.id === payment.projectId)?.quoteId ?? "") && payment.receivedOn <= state.referenceDate).map((payment) => payment.amountCents));
	return {
		approved,
		expenses,
		payments,
		cohort,
		salesCents: sales.toString(),
		costCents: cost.toString(),
		expenseCents: expense.toString(),
		grossProfitCents: (sales - cost).toString(),
		otherIncomeCents: otherIncome.toString(),
		resultCents: (sales - cost - expense + otherIncome).toString(),
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
	"m³": "M3",
	h: "H",
	dia: "DIA",
	kg: "KG",
	l: "L",
	chapa: "CHAPA",
	cx: "CX"
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
/**
* A janela do aparelho lida do banco: só as linhas do último mês e do que está aberto (as mesmas regras do deviceWindow
* do domínio) e, somado no banco, o que vinha de antes (saldo das contas, estoque e funcionários). Abrir o sistema não
* lê mais a empresa inteira (14/11/2026): o histórico só vem quando a tela pede.
*/
async function loadWindow(sql, companyId, referenceDate, days = 31) {
	const dates = windowDates(referenceDate, days), { since } = dates;
	const projectIds = (await sql.query(`select p.id from projects p
       left join (select project_id,sum(amount_cents) filter (where id not in (select payment_id from payment_reversals
                    where company_id=$1)) paid,max(received_on) last from payments
                  where company_id=$1 and command_id is not null group by project_id) pay on pay.project_id=p.id
       where p.company_id=$1 and p.source_quote_id is not null and (
         p.stage not in ('delivered','cancelled') or (p.stage<>'cancelled' and p.total_cents>coalesce(pay.paid,0))
         or ${localDate("p.created_at")}>=$2 or pay.last>=$2::date)`, [companyId, since])).map((row) => row.id);
	const quoteIds = (await sql.query(`select id from commercial_quotes where company_id=$1 and (status in ('draft','sent') or created_on>=$2::date
       or approved_on>=$2::date or id in (select source_quote_id from projects where company_id=$1 and id=any($3::uuid[])))`, [
		companyId,
		since,
		projectIds
	])).map((row) => row.id);
	const ofProjects = ["project_id=any($2::uuid[])", projectIds];
	const windowPayments = `select id from payments where company_id=$1 and command_id is not null and (project_id=any($2::uuid[])
    or received_on>=$3::date or id in (select payment_id from payment_reversals where company_id=$1 and reversed_on>=$3::date))`;
	const [state, accounts, stock, owed] = await Promise.all([
		loadState(sql, companyId, referenceDate, {
			products: true,
			customers: true,
			accounts: true,
			employees: true,
			goals: true,
			projects: ["id=any($2::uuid[])", projectIds],
			quotes: ["id=any($2::uuid[])", quoteIds],
			items: ["quote_id=any($2::uuid[])", quoteIds],
			payments: [
				"id in (" + windowPayments + ")",
				projectIds,
				since
			],
			reversals: [
				"payment_id in (" + windowPayments + ")",
				projectIds,
				since
			],
			charges: ["received_on is null or due_on>=$2::date or received_on>=$2::date", since],
			reservations: ofProjects,
			expenses: ["paid_on is null or incurred_on>=$2::date or paid_on>=$2::date", since],
			inventory: ["occurred_on>=$2::date", since],
			entries: ["entry_date>=$2::date", since],
			transfers: ["transferred_on>=$2::date", since],
			installments: ofProjects,
			tasks: ofProjects,
			notes: ofProjects,
			versions: [
				"quote_id=any($2::uuid[]) and " + localDate("created_at") + ">=$3",
				quoteIds,
				since
			],
			acceptances: ["quote_id=any($2::uuid[])", quoteIds],
			receipts: [
				"issued_on>=$3::date or payment_id in (" + windowPayments + ")",
				projectIds,
				since
			]
		}),
		sql.query(`select a.id,(a.opening_cents
         +coalesce((select sum(amount_cents) from payments p where p.company_id=$1 and p.command_id is not null
            and p.account_id=a.id and p.received_on>=a.opening_on and p.received_on<$2::date),0)
         -coalesce((select sum(amount_cents) from operating_expenses e where e.company_id=$1 and e.account_id=a.id
            and e.paid_on>=a.opening_on and e.paid_on<$2::date),0)
         +coalesce((select sum(case when t.to_account_id=a.id then amount_cents else -amount_cents end) from cash_transfers t
            where t.company_id=$1 and a.id in (t.to_account_id,t.from_account_id)
            and t.transferred_on>=a.opening_on and t.transferred_on<$2::date),0)
         +coalesce((select sum(amount_cents) from receivables c where c.company_id=$1 and c.account_id=a.id
            and c.received_on>=a.opening_on and c.received_on<$2::date),0)
         -coalesce((select sum(p.amount_cents) from payment_reversals r join payments p on p.company_id=r.company_id
            and p.id=r.payment_id where r.company_id=$1 and p.command_id is not null and p.account_id=a.id
            and r.reversed_on>=a.opening_on and r.reversed_on<$2::date),0))::text balance
       from cash_accounts a where a.company_id=$1 and a.opening_on<$2::date`, [companyId, since]),
		sql.query(`select product_id,sum((delta*1000)::bigint)::text delta from inventory_movements
       where company_id=$1 and occurred_on<$2::date group by product_id`, [companyId, since]),
		sql.query(`select employee_id,sum(case when kind in ('work','salary','bonus') then amount_cents else -amount_cents end)::text owed
       from employee_entries where company_id=$1 and entry_date<$2::date group by employee_id`, [companyId, since])
	]);
	return foldWindow(state, {
		accounts: Object.fromEntries(accounts.map((row) => [row.id, row.balance])),
		stock: Object.fromEntries(stock.map((row) => [row.product_id, row.delta])),
		owed: Object.fromEntries(owed.map((row) => [row.employee_id, row.owed]))
	}, dates);
}
async function loadState(sql, companyId, referenceDate, slice) {
	const rows = (table, text) => {
		const part = slice ? slice[table] : true;
		if (!part) return Promise.resolve([]);
		if (part === true) return sql.query(text, [companyId]);
		const [condition, ...values] = part;
		return sql.query(text.replace(" order by ", " and (" + condition + ") order by "), [companyId, ...values]);
	};
	const [products, quotes, items, projects, payments, expenses, inventory, versions, goals, installments, customers, tasks, notes, acceptances, transfers, reversals, charges, reservations, accounts, receipts, employees, entries] = await Promise.all([
		rows("products", `select id,sku,name,kind,category,unit,cost_cents::text as cost,price_cents::text as price,(opening_stock*1000)::bigint::text as opening,(minimum_stock*1000)::bigint::text as minimum,(maximum_stock*1000)::bigint::text as maximum,active,ncm,barcode from catalog_items where company_id=$1 order by created_at desc,id`),
		rows("quotes", `select id,code,title,customer_name,responsible_label,created_on::text,valid_until::text,due_date::text,status,approved_on::text,revision,discount_cents::text as discount,shipping_cents::text as shipping,shipping_cost_cents::text as shipping_cost,notes,customer_id,internal_notes,payment_plan,follow_up_on::text from commercial_quotes where company_id=$1 order by created_on desc,created_at desc,id`),
		rows("items", `select quote_id,id,product_id,sku_snapshot,description_snapshot,kind_snapshot,category_snapshot,unit_snapshot,(quantity*1000)::bigint::text as quantity,unit_price_cents::text as price,unit_cost_cents::text as cost from commercial_quote_items where company_id=$1 order by quote_id,position`),
		rows("projects", `select id,source_quote_id,stage,version,due_date::text,${localDate("created_at")} as created_on from projects where company_id=$1 and source_quote_id is not null order by created_at desc,id`),
		rows("payments", `select id,command_id,project_id,amount_cents::text as amount,received_on::text,method,account_id from payments where company_id=$1 and command_id is not null order by received_on desc,created_at desc,id`),
		rows("expenses", `select id,description,category,quote_id,amount_cents::text as amount,incurred_on::text,paid_on::text,account_id from operating_expenses where company_id=$1 order by incurred_on desc,created_at desc,id`),
		rows("inventory", `select id,product_id,(delta*1000)::bigint::text as delta,reason,occurred_on::text,supplier,unit_cost_cents::text as unit_cost,project_id from inventory_movements where company_id=$1 order by occurred_on desc,created_at desc,id`),
		rows("versions", `select id,quote_id,revision,event,snapshot,reason,${localDate("created_at")} as created_on from commercial_quote_revisions where company_id=$1 order by created_at desc,revision desc,id`),
		rows("goals", `select period_start::text,period_end::text,responsible_label,revenue_target_cents::text as target,(margin_target*100)::int as margin from company_goals where company_id=$1 order by period_start desc,period_end desc,responsible_label`),
		rows("installments", `select id,project_id,due_on::text,amount_cents::text as amount from project_installments where company_id=$1 order by project_id,due_on,id`),
		rows("customers", `select id,name,coalesce(phone,'') as phone,coalesce(email,'') as email,document,street,number,district,city,uf,zip,notes,signature from customers where company_id=$1 order by name,id`),
		rows("tasks", `select id,project_id,description,responsible,due_on::text,done_on::text from project_tasks where company_id=$1 order by created_at,id`),
		rows("notes", `select id,project_id,kind,body,created_on::text from project_notes where company_id=$1 order by created_at desc,id`),
		rows("acceptances", `select quote_id,${localDate("accepted_at")} as accepted_on,accepted_name,accepted_revision from quote_links where company_id=$1 and accepted_at is not null order by accepted_at desc`),
		rows("transfers", `select id,from_account_id,to_account_id,amount_cents::text as amount,transferred_on::text,note from cash_transfers where company_id=$1 order by transferred_on desc,created_at desc,id`),
		rows("reversals", `select id,payment_id,coalesce(reversed_on::text,${localDate("created_at")}) as reversed_on,reason from payment_reversals where company_id=$1 and payment_id in (select id from payments where company_id=$1 and command_id is not null) order by created_at desc,id`),
		rows("charges", `select id,customer_id,customer_name,description,amount_cents::text as amount,due_on::text,received_on::text,method,account_id from receivables where company_id=$1 order by due_on desc,created_at desc,id`),
		rows("reservations", `select id,project_id,product_id,(quantity*1000)::bigint::text as quantity,reserved_on::text from material_reservations where company_id=$1 order by created_at,id`),
		rows("accounts", `select id,name,opening_cents::text as opening,opening_on::text,active from cash_accounts where company_id=$1 order by created_at,id`),
		rows("receipts", `select id,number,kind,issued_on::text,party,party_document,customer_id,employee_id,amount_cents::text as amount,deductions,reference,method,payment_id,notes from receipts where company_id=$1 order by number desc`),
		rows("employees", `select id,name,role,phone,document,hired_on::text,contract,pay_basis,rate_cents::text as rate,pix_key,active,notes from employees where company_id=$1 order by name,id`),
		rows("entries", `select id,employee_id,kind,entry_date::text,(quantity*1000)::bigint::text as quantity,amount_cents::text as amount,project_id,note,account_id from employee_entries where company_id=$1 order by entry_date desc,created_at desc,id`)
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
			...row.ncm && { ncm: row.ncm },
			...row.barcode && { barcode: row.barcode }
		})),
		customers,
		receipts: receipts.map((row) => ({
			id: row.id,
			number: row.number,
			kind: row.kind,
			issuedOn: row.issued_on,
			party: row.party,
			partyDocument: row.party_document,
			customerId: row.customer_id,
			employeeId: row.employee_id,
			amountCents: row.amount,
			deductions: row.deductions,
			reference: row.reference,
			method: row.method,
			paymentId: row.payment_id,
			notes: row.notes
		})),
		employees: employees.map((row) => ({
			id: row.id,
			name: row.name,
			role: row.role,
			phone: row.phone,
			document: row.document,
			hiredOn: row.hired_on,
			contract: row.contract,
			payBasis: row.pay_basis,
			rateCents: row.rate,
			pixKey: row.pix_key,
			active: row.active,
			notes: row.notes
		})),
		employeeEntries: entries.map((row) => ({
			id: row.id,
			employeeId: row.employee_id,
			kind: row.kind,
			date: row.entry_date,
			quantityMilli: row.quantity,
			amountCents: row.amount,
			projectId: row.project_id,
			note: row.note,
			accountId: row.account_id
		})),
		accounts: accounts.map((row) => ({
			id: row.id,
			name: row.name,
			openingCents: row.opening,
			openingOn: row.opening_on,
			active: row.active
		})),
		transfers: transfers.map((row) => ({
			id: row.id,
			fromAccountId: row.from_account_id,
			toAccountId: row.to_account_id,
			amountCents: row.amount,
			transferredOn: row.transferred_on,
			note: row.note
		})),
		reversals: reversals.map((row) => ({
			id: row.id,
			paymentId: row.payment_id,
			reversedOn: row.reversed_on,
			reason: row.reason
		})),
		charges: charges.map((row) => ({
			id: row.id,
			customerId: row.customer_id,
			customerName: row.customer_name,
			description: row.description,
			amountCents: row.amount,
			dueOn: row.due_on,
			receivedOn: row.received_on,
			method: row.method,
			accountId: row.account_id
		})),
		reservations: reservations.map((row) => ({
			id: row.id,
			projectId: row.project_id,
			productId: row.product_id,
			quantityMilli: row.quantity,
			reservedOn: row.reserved_on
		})),
		acceptances: acceptances.map((row) => ({
			quoteId: row.quote_id,
			acceptedOn: row.accepted_on,
			name: row.accepted_name,
			revision: row.accepted_revision
		})),
		tasks: tasks.map((row) => ({
			id: row.id,
			projectId: row.project_id,
			description: row.description,
			responsible: row.responsible,
			dueOn: row.due_on,
			doneOn: row.done_on
		})),
		notes: notes.map((row) => ({
			id: row.id,
			projectId: row.project_id,
			kind: row.kind,
			text: row.body,
			createdOn: row.created_on
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
			customerId: row.customer_id,
			internalNotes: row.internal_notes,
			paymentPlan: row.payment_plan,
			followUpOn: row.follow_up_on,
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
			method: row.method,
			accountId: row.account_id ?? null
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
			paidOn: row.paid_on,
			accountId: row.account_id
		})),
		inventory: inventory.map((row) => ({
			id: row.id,
			productId: row.product_id,
			deltaMilli: row.delta,
			reason: row.reason,
			occurredOn: row.occurred_on,
			...row.supplier && { supplier: row.supplier },
			...row.unit_cost && { unitCostCents: row.unit_cost },
			...row.project_id && { projectId: row.project_id }
		})),
		versions: versions.map((row) => ({
			id: row.id,
			quoteId: row.quote_id,
			revision: row.revision,
			snapshot: row.snapshot,
			reason: row.reason ?? (row.event === "approved" ? "Aprovação e criação de projeto" : row.revision === 1 ? "Criação" : "Edição comercial"),
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
const quoteOfProject = "(select source_quote_id from projects where company_id=$1 and id=$2)";
/**
* O que cada comando lê e o registro que ele trava. Pessoas mexendo em coisas diferentes gravam ao mesmo tempo; duas
* no mesmo registro (a mesma obra, o mesmo orçamento) vão uma depois da outra. As regras do domínio procuram tudo pelo
* id, então a parte lida basta; o que precisa ser único na empresa o banco garante.
*/
/**
* Número do orçamento novo: o aparelho propõe o seguinte ao maior que ele tem, mas guarda só o último mês e pode estar
* sem internet junto com outro; se o número já existe, vale o próximo livre da empresa (a resposta leva o número novo).
* Antes, o servidor recusava e o vendedor não conseguia mais criar orçamento (simulação de 14/11/2026).
*/
async function freeQuoteCode(sql, companyId, command) {
	const { quote } = command;
	const [existing] = await sql.query("select id from commercial_quotes where company_id=$1 and id=$2", [companyId, quote.id]);
	if (existing) return command;
	await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [companyId + ":quote-codes"]);
	const [taken] = await sql.query("select 1 from commercial_quotes where company_id=$1 and code=$2", [companyId, quote.code]);
	if (!taken) return command;
	const prefix = quote.code.replace(/\d+$/, "");
	const codes = await sql.query("select code from commercial_quotes where company_id=$1 and left(code,length($2))=$2", [companyId, prefix]);
	const latest = Math.max(0, ...codes.map((row) => Number(row.code.slice(prefix.length)) || 0));
	return {
		...command,
		quote: {
			...quote,
			code: prefix + String(latest + 1).padStart(3, "0")
		}
	};
}
function commandSlice(command) {
	const quote = (id) => ({
		quotes: ["id=$2", id],
		items: ["quote_id=$2", id]
	});
	const project = (id) => ({ projects: ["id=$2", id] });
	const projectWithQuote = (id) => ({
		...project(id),
		quotes: ["id=" + quoteOfProject, id],
		items: ["quote_id=" + quoteOfProject, id]
	});
	switch (command.type) {
		case "saveCatalogItem": return {
			slice: { products: true },
			lock: "product:" + command.item.id
		};
		case "moveInventory": return {
			slice: {
				products: ["id=$2", command.movement.productId],
				inventory: ["product_id=$2", command.movement.productId],
				...command.movement.projectId && {
					projects: ["id=$2", command.movement.projectId],
					reservations: [
						"project_id=$2 and product_id=$3",
						command.movement.projectId,
						command.movement.productId
					]
				}
			},
			lock: "product:" + command.movement.productId
		};
		case "saveQuote": return {
			slice: {
				quotes: [
					"id=$2 or code=$3",
					command.quote.id,
					command.quote.code
				],
				items: [
					"quote_id in (select id from commercial_quotes where company_id=$1 and (id=$2 or code=$3))",
					command.quote.id,
					command.quote.code
				],
				products: ["id = any($2::uuid[])", command.quote.items.map((item) => item.productId)],
				...command.quote.customerId && { customers: ["id=$2", command.quote.customerId] },
				versions: ["id=$2", command.eventId]
			},
			lock: "quote:" + command.quote.id
		};
		case "approveQuote": return {
			slice: {
				...quote(command.quoteId),
				projects: [
					"id=$2 or source_quote_id=$3",
					command.projectId,
					command.quoteId
				],
				installments: ["project_id=$2", command.projectId],
				versions: ["id=$2", command.eventId]
			},
			lock: "quote:" + command.quoteId
		};
		case "amendQuote": return {
			slice: {
				...projectWithQuote(command.projectId),
				payments: ["project_id=$2", command.projectId],
				reversals: ["payment_id in (select id from payments where company_id=$1 and project_id=$2)", command.projectId],
				installments: ["project_id=$2", command.projectId],
				products: ["id = any($2::uuid[])", command.quote.items.map((item) => item.productId)],
				...command.quote.customerId && { customers: ["id=$2", command.quote.customerId] },
				versions: ["id=$2", command.eventId],
				notes: ["id=$2", command.eventId]
			},
			lock: "project:" + command.projectId
		};
		case "saveCustomer": return {
			slice: { customers: ["id=$2", command.customer.id] },
			lock: "customer:" + command.customer.id
		};
		case "setFollowUp": return {
			slice: quote(command.quoteId),
			lock: "quote:" + command.quoteId
		};
		case "addPayment": return {
			slice: {
				...projectWithQuote(command.payment.projectId),
				payments: [
					"project_id=$2 or command_id=$3",
					command.payment.projectId,
					command.payment.commandId
				],
				reversals: ["payment_id in (select id from payments where company_id=$1 and project_id=$2)", command.payment.projectId],
				accounts: true
			},
			lock: "project:" + command.payment.projectId
		};
		case "reversePayment": return {
			slice: {
				payments: ["id=$2", command.reversal.paymentId],
				reversals: [
					"payment_id=$2 or id=$3",
					command.reversal.paymentId,
					command.reversal.id
				],
				projects: ["id=(select project_id from payments where company_id=$1 and id=$2)", command.reversal.paymentId],
				notes: ["id=$2", command.reversal.id]
			},
			lock: "payment:" + command.reversal.paymentId
		};
		case "moveProject": return {
			slice: {
				...project(command.projectId),
				payments: ["project_id=$2", command.projectId],
				reversals: ["payment_id in (select id from payments where company_id=$1 and project_id=$2)", command.projectId],
				...command.noteId && { notes: ["id=$2", command.noteId] }
			},
			lock: "project:" + command.projectId
		};
		case "saveTask": return {
			slice: {
				...project(command.task.projectId),
				tasks: ["id=$2", command.task.id]
			},
			lock: "project:" + command.task.projectId
		};
		case "deleteTask": return {
			slice: { tasks: ["id=$2", command.taskId] },
			lock: "task:" + command.taskId
		};
		case "addProjectNote": return {
			slice: {
				...project(command.note.projectId),
				notes: ["id=$2", command.note.id]
			},
			lock: "project:" + command.note.projectId
		};
		case "planInstallments": return {
			slice: {
				...projectWithQuote(command.projectId),
				installments: ["project_id=$2", command.projectId]
			},
			lock: "project:" + command.projectId
		};
		case "addExpense": return {
			slice: {
				expenses: ["id=$2", command.expense.id],
				...command.expense.quoteId && quote(command.expense.quoteId)
			},
			lock: "expense:" + command.expense.id
		};
		case "payExpense": return {
			slice: {
				expenses: ["id=$2", command.expenseId],
				accounts: true
			},
			lock: "expense:" + command.expenseId
		};
		case "addCharge": return {
			slice: {
				charges: ["id=$2", command.charge.id],
				...command.charge.customerId && { customers: ["id=$2", command.charge.customerId] }
			},
			lock: "charge:" + command.charge.id
		};
		case "receiveCharge": return {
			slice: {
				charges: ["id=$2", command.chargeId],
				accounts: true
			},
			lock: "charge:" + command.chargeId
		};
		case "deleteCharge": return {
			slice: { charges: ["id=$2", command.chargeId] },
			lock: "charge:" + command.chargeId
		};
		case "reserveMaterial": return {
			slice: {
				reservations: [
					"id=$2 or (project_id=$3 and product_id=$4)",
					command.reservation.id,
					command.reservation.projectId,
					command.reservation.productId
				],
				products: ["id=$2", command.reservation.productId],
				projects: ["id=$2", command.reservation.projectId]
			},
			lock: "product:" + command.reservation.productId
		};
		case "releaseMaterial": return {
			slice: { reservations: ["id=$2", command.reservationId] },
			lock: "reservation:" + command.reservationId
		};
		case "saveAccount": return {
			slice: { accounts: true },
			lock: "account:" + command.account.id
		};
		case "transferCash": return {
			slice: {
				accounts: true,
				transfers: ["id=$2", command.transfer.id]
			},
			lock: "transfer:" + command.transfer.id
		};
		case "saveGoal": return {
			slice: { goals: true },
			lock: "goals"
		};
		case "issueReceipt": return {
			slice: {
				receipts: [
					"id=$2 or payment_id=$3 or number=(select max(number) from receipts where company_id=$1)",
					command.receipt.id,
					command.receipt.paymentId
				],
				...command.receipt.paymentId && { payments: ["id=$2", command.receipt.paymentId] },
				...command.receipt.employeeId && { employees: ["id=$2", command.receipt.employeeId] }
			},
			lock: "receipts"
		};
		case "saveEmployee": return {
			slice: { employees: ["id=$2", command.employee.id] },
			lock: "employee:" + command.employee.id
		};
		case "addEmployeeEntry": return {
			slice: {
				entries: ["id=$2", command.entry.id],
				employees: ["id=$2", command.entry.employeeId],
				...command.entry.projectId && project(command.entry.projectId),
				accounts: true,
				expenses: ["id=$2", command.entry.id]
			},
			lock: "employee:" + command.entry.employeeId
		};
		case "deleteEmployeeEntry": return {
			slice: { entries: ["id=$2", command.entryId] },
			lock: "entry:" + command.entryId
		};
	}
}
async function writeProduct(sql, scope, item) {
	await sql.query(`insert into catalog_items(id,company_id,sku,name,kind,category,unit,price_cents,cost_cents,opening_stock,minimum_stock,active,ncm,maximum_stock,barcode)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric/1000,$11::numeric/1000,$12,$13,$14::numeric/1000,$15)
     on conflict (id) do update set sku=excluded.sku,name=excluded.name,category=excluded.category,price_cents=excluded.price_cents,
     cost_cents=excluded.cost_cents,minimum_stock=excluded.minimum_stock,active=excluded.active,ncm=excluded.ncm,
     maximum_stock=excluded.maximum_stock,barcode=excluded.barcode,version=catalog_items.version+1
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
		item.maxStockMilli ?? null,
		item.barcode ?? null
	]);
}
async function writeQuote(sql, scope, quote, catalog) {
	await sql.query(`insert into commercial_quotes(id,company_id,code,customer_name,title,responsible_label,status,revision,created_on,valid_until,due_date,discount_cents,shipping_cents,shipping_cost_cents,notes,customer_id,internal_notes,payment_plan,follow_up_on,approved_on)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text::jsonb,$19,null)
     on conflict (id) do update set code=excluded.code,customer_name=excluded.customer_name,title=excluded.title,
     responsible_label=excluded.responsible_label,status=excluded.status,revision=excluded.revision,created_on=excluded.created_on,
     valid_until=excluded.valid_until,due_date=excluded.due_date,discount_cents=excluded.discount_cents,
     shipping_cents=excluded.shipping_cents,shipping_cost_cents=excluded.shipping_cost_cents,notes=excluded.notes,
     customer_id=excluded.customer_id,internal_notes=excluded.internal_notes,payment_plan=excluded.payment_plan,
     follow_up_on=excluded.follow_up_on,approved_on=null
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
		quote.notes,
		quote.customerId,
		quote.internalNotes,
		quote.paymentPlan && JSON.stringify(quote.paymentPlan),
		quote.followUpOn
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
const approve = (sql, scope, quote) => sql.query(`update commercial_quotes set status='approved',approved_on=$3,follow_up_on=null where company_id=$1 and id=$2`, [
	scope.companyId,
	quote.id,
	quote.approvedOn
]);
async function writeCustomer(sql, scope, customer) {
	await sql.query(`insert into customers(id,company_id,name,phone,email,document,street,number,district,city,uf,zip,notes,signature)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,document=excluded.document,
     street=excluded.street,number=excluded.number,district=excluded.district,city=excluded.city,uf=excluded.uf,
     zip=excluded.zip,notes=excluded.notes,signature=excluded.signature,updated_at=now()
     where customers.company_id=excluded.company_id`, [
		customer.id,
		scope.companyId,
		customer.name,
		customer.phone,
		customer.email,
		customer.document,
		customer.street,
		customer.number,
		customer.district,
		customer.city,
		customer.uf,
		customer.zip,
		customer.notes,
		customer.signature
	]);
}
async function writeTask(sql, scope, task) {
	await sql.query(`insert into project_tasks(id,company_id,project_id,description,responsible,due_on,done_on)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set description=excluded.description,responsible=excluded.responsible,
     due_on=excluded.due_on,done_on=excluded.done_on,version=project_tasks.version+1
     where project_tasks.company_id=excluded.company_id`, [
		task.id,
		scope.companyId,
		task.projectId,
		task.description,
		task.responsible,
		task.dueOn,
		task.doneOn
	]);
}
async function writeNote(sql, scope, note) {
	await sql.query(`insert into project_notes(id,company_id,project_id,kind,body,created_on,actor_id) values($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do nothing`, [
		note.id,
		scope.companyId,
		note.projectId,
		note.kind,
		note.text,
		note.createdOn,
		scope.userId
	]);
}
const versionEvent = (version) => version.reason.startsWith("Aprova") ? "approved" : version.reason.startsWith("Aditivo") ? "amended" : "saved";
async function writeVersion(sql, scope, version) {
	await sql.query(`insert into commercial_quote_revisions(id,company_id,quote_id,revision,event,snapshot,actor_id,created_at,reason)
     values($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::timestamptz,$9) on conflict do nothing`, [
		version.id,
		scope.companyId,
		version.quoteId,
		version.revision,
		versionEvent(version),
		JSON.stringify(version.snapshot),
		scope.userId,
		noon(version.createdOn),
		versionEvent(version) === "amended" ? version.reason : null
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
	await sql.query(`insert into payments(id,company_id,project_id,amount_cents,received_at,received_on,method,command_id,created_by,account_id)
     values($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10) on conflict do nothing`, [
		payment.id,
		scope.companyId,
		payment.projectId,
		payment.amountCents,
		noon(payment.receivedOn),
		payment.receivedOn,
		payment.method,
		payment.commandId,
		scope.userId,
		payment.accountId
	]);
}
async function writeExpense(sql, scope, expense) {
	await sql.query(`insert into operating_expenses(id,company_id,quote_id,description,category,amount_cents,incurred_on,paid_on,actor_id,account_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`, [
		expense.id,
		scope.companyId,
		expense.quoteId,
		expense.description,
		expense.category,
		expense.amountCents,
		expense.incurredOn,
		expense.paidOn,
		scope.userId,
		expense.accountId
	]);
}
async function writeAccount(sql, scope, account) {
	await sql.query(`insert into cash_accounts(id,company_id,name,opening_cents,opening_on,active) values($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set name=excluded.name,opening_cents=excluded.opening_cents,opening_on=excluded.opening_on,
     active=excluded.active where cash_accounts.company_id=excluded.company_id`, [
		account.id,
		scope.companyId,
		account.name,
		account.openingCents,
		account.openingOn,
		account.active
	]);
}
async function writeTransfer(sql, scope, transfer) {
	await sql.query(`insert into cash_transfers(id,company_id,from_account_id,to_account_id,amount_cents,transferred_on,note,created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`, [
		transfer.id,
		scope.companyId,
		transfer.fromAccountId,
		transfer.toAccountId,
		transfer.amountCents,
		transfer.transferredOn,
		transfer.note,
		scope.userId
	]);
}
async function writeMovement(sql, scope, movement) {
	await sql.query(`insert into inventory_movements(id,company_id,product_id,delta,reason,occurred_on,actor_id,supplier,unit_cost_cents,project_id)
     values($1,$2,$3,$4::numeric/1000,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`, [
		movement.id,
		scope.companyId,
		movement.productId,
		movement.deltaMilli,
		movement.reason,
		movement.occurredOn,
		scope.userId,
		movement.supplier ?? null,
		movement.unitCostCents ?? null,
		movement.projectId ?? null
	]);
}
async function writeCharge(sql, scope, charge) {
	await sql.query(`insert into receivables(id,company_id,customer_id,customer_name,description,amount_cents,due_on,received_on,method,account_id,created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (id) do update set received_on=excluded.received_on,
     method=excluded.method,account_id=excluded.account_id where receivables.company_id=excluded.company_id`, [
		charge.id,
		scope.companyId,
		charge.customerId,
		charge.customerName,
		charge.description,
		charge.amountCents,
		charge.dueOn,
		charge.receivedOn,
		charge.method,
		charge.accountId,
		scope.userId
	]);
}
/** Reserva da obra como ficou depois do comando: gravada, com a quantidade nova, ou apagada (retirada inteira). */
async function writeReservations(sql, scope, before, after) {
	if (after.reservations === before.reservations) return;
	const kept = new Set(after.reservations.map((item) => item.id));
	for (const item of before.reservations) if (!kept.has(item.id)) await sql.query("delete from material_reservations where company_id=$1 and id=$2", [scope.companyId, item.id]);
	const old = new Map(before.reservations.map((item) => [item.id, JSON.stringify(item)]));
	for (const item of after.reservations) if (old.get(item.id) !== JSON.stringify(item)) await sql.query(`insert into material_reservations(id,company_id,project_id,product_id,quantity,reserved_on)
         values($1,$2,$3,$4,$5::numeric/1000,$6) on conflict (id) do update set quantity=excluded.quantity,
         reserved_on=excluded.reserved_on where material_reservations.company_id=excluded.company_id`, [
		item.id,
		scope.companyId,
		item.projectId,
		item.productId,
		item.quantityMilli,
		item.reservedOn
	]);
}
async function writeReceipt(sql, scope, receipt) {
	await sql.query(`insert into receipts(id,company_id,number,kind,issued_on,party,party_document,customer_id,employee_id,amount_cents,reference,method,payment_id,notes,created_by,deductions)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text::jsonb) on conflict (id) do nothing`, [
		receipt.id,
		scope.companyId,
		receipt.number,
		receipt.kind,
		receipt.issuedOn,
		receipt.party,
		receipt.partyDocument,
		receipt.customerId,
		receipt.employeeId,
		receipt.amountCents,
		receipt.reference,
		receipt.method,
		receipt.paymentId,
		receipt.notes,
		scope.userId,
		JSON.stringify(receipt.deductions)
	]);
}
async function writeEmployee(sql, scope, employee) {
	await sql.query(`insert into employees(id,company_id,name,role,phone,document,hired_on,contract,pay_basis,rate_cents,pix_key,active,notes)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (id) do update set name=excluded.name,role=excluded.role,phone=excluded.phone,document=excluded.document,
     hired_on=excluded.hired_on,contract=excluded.contract,pay_basis=excluded.pay_basis,rate_cents=excluded.rate_cents,
     pix_key=excluded.pix_key,active=excluded.active,notes=excluded.notes where employees.company_id=excluded.company_id`, [
		employee.id,
		scope.companyId,
		employee.name,
		employee.role,
		employee.phone,
		employee.document,
		employee.hiredOn,
		employee.contract,
		employee.payBasis,
		employee.rateCents,
		employee.pixKey,
		employee.active,
		employee.notes
	]);
}
async function writeEmployeeEntry(sql, scope, entry) {
	await sql.query(`insert into employee_entries(id,company_id,employee_id,kind,entry_date,quantity,amount_cents,project_id,note,account_id,created_by)
     values($1,$2,$3,$4,$5,$6::numeric/1000,$7,$8,$9,$10,$11) on conflict (id) do nothing`, [
		entry.id,
		scope.companyId,
		entry.employeeId,
		entry.kind,
		entry.date,
		entry.quantityMilli,
		entry.amountCents,
		entry.projectId,
		entry.note,
		entry.accountId,
		scope.userId
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
/** Para quem não vê custo (vendas, com a opção ligada): custos zerados e sem despesas, antes de sair do servidor. */
function stripCosts(state) {
	const quote = (item) => ({
		...item,
		shippingCostCents: "0",
		items: item.items.map((line) => ({
			...line,
			unitCostCents: "0"
		}))
	});
	return {
		...state,
		products: state.products.map((item) => ({
			...item,
			costCents: "0"
		})),
		quotes: state.quotes.map(quote),
		versions: state.versions.map((version) => ({
			...version,
			snapshot: quote(version.snapshot)
		})),
		inventory: state.inventory.map((movement) => {
			const copy = { ...movement };
			delete copy.unitCostCents;
			return copy;
		}),
		expenses: [],
		transfers: [],
		employees: state.employees.map((item) => ({
			...item,
			rateCents: "0"
		})),
		employeeEntries: []
	};
}
/** O que chega de quem não vê custo vem com custo zero: o servidor repõe o custo gravado (ou o do catálogo). */
function restoreCosts(command, state) {
	if (command.type === "saveQuote" || command.type === "amendQuote") {
		const previous = state.quotes.find((item) => item.id === command.quote.id);
		return {
			...command,
			quote: {
				...command.quote,
				shippingCostCents: previous?.shippingCostCents ?? "0",
				items: command.quote.items.map((line) => ({
					...line,
					unitCostCents: previous?.items.find((old) => old.id === line.id)?.unitCostCents ?? state.products.find((product) => product.id === line.productId)?.costCents ?? "0"
				}))
			}
		};
	}
	if (command.type === "saveCatalogItem") return {
		...command,
		item: {
			...command.item,
			costCents: state.products.find((item) => item.id === command.item.id)?.costCents ?? "0"
		}
	};
	return command;
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
			await writeMovement(sql, scope, after.inventory.find((item) => item.id === entity));
			await writeReservations(sql, scope, before, after);
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
			if (command.installments?.length) await writeInstallments(sql, scope.companyId, after.installments.filter((item) => item.projectId === command.projectId));
			break;
		case "amendQuote": {
			entity = command.quote.id;
			const amended = quote(entity);
			await sql.query("select set_config('app.amending',$1,true)", [entity]);
			await writeQuote(sql, scope, amended, new Set(after.products.map((item) => item.id)));
			await sql.query("select set_config('app.amending','',true)");
			const totals = quoteTotals(amended);
			await sql.query("update projects set total_cents=$3,planned_cost_cents=$4,due_date=$5,version=version+1,updated_at=now() where company_id=$1 and id=$2", [
				scope.companyId,
				command.projectId,
				totals.totalCents,
				totals.costCents,
				amended.dueDate
			]);
			await writeVersion(sql, scope, version(command.eventId));
			await writeNote(sql, scope, after.notes.find((item) => item.id === command.eventId));
			if (after.installments !== before.installments) {
				await sql.query("delete from project_installments where company_id=$1 and project_id=$2", [scope.companyId, command.projectId]);
				await writeInstallments(sql, scope.companyId, after.installments.filter((item) => item.projectId === command.projectId));
			}
			break;
		}
		case "reversePayment":
			entity = command.reversal.paymentId;
			await sql.query("insert into payment_reversals(id,company_id,payment_id,reason,created_by,reversed_on) values($1,$2,$3,$4,$5,$6)", [
				command.reversal.id,
				scope.companyId,
				entity,
				command.reversal.reason,
				scope.userId,
				command.reversal.reversedOn
			]);
			await sql.query("update projects set version=version+1,updated_at=now() where company_id=$1 and id=(select project_id from payments where company_id=$1 and id=$2)", [scope.companyId, entity]);
			await writeNote(sql, scope, after.notes.find((item) => item.id === command.reversal.id));
			break;
		case "addCharge":
		case "receiveCharge": {
			const id = command.type === "addCharge" ? command.charge.id : command.chargeId;
			entity = id;
			await writeCharge(sql, scope, after.charges.find((item) => item.id === id));
			break;
		}
		case "deleteCharge":
			entity = command.chargeId;
			await sql.query("delete from receivables where company_id=$1 and id=$2 and received_on is null", [scope.companyId, entity]);
			break;
		case "reserveMaterial":
		case "releaseMaterial":
			entity = command.type === "reserveMaterial" ? command.reservation.id : command.reservationId;
			await writeReservations(sql, scope, before, after);
			break;
		case "saveCustomer":
			entity = command.customer.id;
			await writeCustomer(sql, scope, after.customers.find((item) => item.id === entity));
			break;
		case "setFollowUp":
			entity = command.quoteId;
			await sql.query("update commercial_quotes set follow_up_on=$3 where company_id=$1 and id=$2", [
				scope.companyId,
				entity,
				command.followUpOn
			]);
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
			if (command.noteId) await writeNote(sql, scope, after.notes.find((item) => item.id === command.noteId));
			break;
		case "saveTask":
			entity = command.task.id;
			await writeTask(sql, scope, after.tasks.find((item) => item.id === entity));
			break;
		case "deleteTask":
			entity = command.taskId;
			await sql.query("delete from project_tasks where company_id=$1 and id=$2", [scope.companyId, entity]);
			break;
		case "addProjectNote":
			entity = command.note.id;
			await writeNote(sql, scope, after.notes.find((item) => item.id === entity));
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
			await sql.query("update operating_expenses set paid_on=$3,account_id=$4 where company_id=$1 and id=$2", [
				scope.companyId,
				entity,
				command.paidOn,
				command.accountId ?? null
			]);
			break;
		case "saveAccount":
			entity = command.account.id;
			await writeAccount(sql, scope, after.accounts.find((item) => item.id === entity));
			break;
		case "transferCash":
			entity = command.transfer.id;
			await writeTransfer(sql, scope, after.transfers.find((item) => item.id === entity));
			break;
		case "saveGoal":
			entity = scope.companyId;
			await writeGoal(sql, scope, command.goal);
			break;
		case "issueReceipt":
			entity = command.receipt.id;
			await writeReceipt(sql, scope, after.receipts.find((item) => item.id === entity));
			break;
		case "saveEmployee":
			entity = command.employee.id;
			await writeEmployee(sql, scope, after.employees.find((item) => item.id === entity));
			break;
		case "addEmployeeEntry":
			entity = command.entry.id;
			await writeEmployeeEntry(sql, scope, command.entry);
			if (after.expenses !== before.expenses) await writeExpense(sql, scope, after.expenses.find((item) => item.id === entity));
			break;
		case "deleteEmployeeEntry":
			entity = command.entryId;
			await sql.query("delete from employee_entries where company_id=$1 and id=$2 and kind in ('work','salary','bonus','discount')", [scope.companyId, entity]);
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
		customerId: item.customerId && id(item.customerId),
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
		customers: state.customers.map((item) => ({
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
			projectId: id(item.projectId),
			accountId: item.accountId && id(item.accountId)
		})),
		installments: state.installments.map((item) => ({
			...item,
			id: id(item.id),
			projectId: id(item.projectId)
		})),
		acceptances: [],
		accounts: state.accounts.map((item) => ({
			...item,
			id: id(item.id)
		})),
		transfers: state.transfers.map((item) => ({
			...item,
			id: id(item.id),
			fromAccountId: id(item.fromAccountId),
			toAccountId: id(item.toAccountId)
		})),
		employees: state.employees.map((item) => ({
			...item,
			id: id(item.id)
		})),
		employeeEntries: state.employeeEntries.map((item) => ({
			...item,
			id: id(item.id),
			employeeId: id(item.employeeId),
			projectId: item.projectId && id(item.projectId),
			accountId: item.accountId && id(item.accountId)
		})),
		receipts: state.receipts.map((item) => ({
			...item,
			id: id(item.id),
			customerId: item.customerId && id(item.customerId),
			employeeId: item.employeeId && id(item.employeeId),
			paymentId: item.paymentId && id(item.paymentId)
		})),
		tasks: state.tasks.map((item) => ({
			...item,
			id: id(item.id),
			projectId: id(item.projectId)
		})),
		notes: state.notes.map((item) => ({
			...item,
			id: id(item.id),
			projectId: id(item.projectId)
		})),
		expenses: state.expenses.map((item) => ({
			...item,
			id: id(item.id),
			quoteId: item.quoteId && id(item.quoteId),
			accountId: item.accountId && id(item.accountId)
		})),
		inventory: state.inventory.map((item) => ({
			...item,
			id: id(item.id),
			productId: id(item.productId),
			...item.projectId && { projectId: id(item.projectId) }
		})),
		reversals: state.reversals.map((item) => ({
			...item,
			id: id(item.id),
			paymentId: id(item.paymentId)
		})),
		charges: state.charges.map((item) => ({
			...item,
			id: id(item.id),
			customerId: item.customerId && id(item.customerId),
			accountId: item.accountId && id(item.accountId)
		})),
		reservations: state.reservations.map((item) => ({
			...item,
			id: id(item.id),
			projectId: id(item.projectId),
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
		ncm: "text",
		barcode: "text"
	}, state.products.map((item) => ({
		barcode: item.barcode ?? null,
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
	await insertMany(sql, "customers", {
		id: "uuid",
		company_id: "uuid",
		name: "text",
		phone: "text",
		email: "text",
		document: "text",
		street: "text",
		number: "text",
		district: "text",
		city: "text",
		uf: "text",
		zip: "text",
		notes: "text",
		signature: "text"
	}, state.customers.map((customer) => ({
		...customer,
		company_id
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
		notes: "text",
		customer_id: "uuid",
		internal_notes: "text",
		payment_plan: "jsonb",
		follow_up_on: "date"
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
		notes: quote.notes,
		customer_id: quote.customerId,
		internal_notes: quote.internalNotes,
		payment_plan: quote.paymentPlan,
		follow_up_on: quote.followUpOn
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
		created_at: "timestamptz",
		reason: "text"
	}, state.versions.map((version) => ({
		id: version.id,
		company_id,
		quote_id: version.quoteId,
		revision: version.revision,
		event: versionEvent(version),
		snapshot: version.snapshot,
		actor_id: scope.userId,
		created_at: noon(version.createdOn),
		reason: versionEvent(version) === "amended" ? version.reason : null
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
	await insertMany(sql, "cash_accounts", {
		id: "uuid",
		company_id: "uuid",
		name: "text",
		opening_cents: "bigint",
		opening_on: "date",
		active: "boolean"
	}, state.accounts.map((account) => ({
		id: account.id,
		company_id,
		name: account.name,
		opening_cents: account.openingCents,
		opening_on: account.openingOn,
		active: account.active
	})));
	await insertMany(sql, "cash_transfers", {
		id: "uuid",
		company_id: "uuid",
		from_account_id: "uuid",
		to_account_id: "uuid",
		amount_cents: "bigint",
		transferred_on: "date",
		note: "text",
		created_by: "uuid"
	}, state.transfers.map((transfer) => ({
		id: transfer.id,
		company_id,
		from_account_id: transfer.fromAccountId,
		to_account_id: transfer.toAccountId,
		amount_cents: transfer.amountCents,
		transferred_on: transfer.transferredOn,
		note: transfer.note,
		created_by: scope.userId
	})));
	await insertMany(sql, "payments", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		amount_cents: "bigint",
		received_at: "timestamptz",
		received_on: "date",
		method: "text",
		command_id: "uuid",
		created_by: "uuid",
		account_id: "uuid"
	}, state.payments.map((payment) => ({
		id: payment.id,
		company_id,
		project_id: payment.projectId,
		amount_cents: payment.amountCents,
		received_at: noon(payment.receivedOn),
		received_on: payment.receivedOn,
		method: payment.method,
		command_id: payment.commandId,
		created_by: scope.userId,
		account_id: payment.accountId
	})));
	await writeInstallments(sql, company_id, state.installments);
	await insertMany(sql, "project_tasks", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		description: "text",
		responsible: "text",
		due_on: "date",
		done_on: "date"
	}, state.tasks.map((task) => ({
		id: task.id,
		company_id,
		project_id: task.projectId,
		description: task.description,
		responsible: task.responsible,
		due_on: task.dueOn,
		done_on: task.doneOn
	})));
	await insertMany(sql, "project_notes", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		kind: "text",
		body: "text",
		created_on: "date",
		actor_id: "uuid"
	}, state.notes.map((note) => ({
		id: note.id,
		company_id,
		project_id: note.projectId,
		kind: note.kind,
		body: note.text,
		created_on: note.createdOn,
		actor_id: scope.userId
	})));
	await insertMany(sql, "operating_expenses", {
		id: "uuid",
		company_id: "uuid",
		quote_id: "uuid",
		description: "text",
		category: "text",
		amount_cents: "bigint",
		incurred_on: "date",
		paid_on: "date",
		actor_id: "uuid",
		account_id: "uuid"
	}, state.expenses.map((expense) => ({
		id: expense.id,
		company_id,
		quote_id: expense.quoteId,
		description: expense.description,
		category: expense.category,
		amount_cents: expense.amountCents,
		incurred_on: expense.incurredOn,
		paid_on: expense.paidOn,
		actor_id: scope.userId,
		account_id: expense.accountId
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
		unit_cost_cents: "bigint",
		project_id: "uuid"
	}, state.inventory.map((movement) => ({
		project_id: movement.projectId ?? null,
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
	await insertMany(sql, "employees", {
		id: "uuid",
		company_id: "uuid",
		name: "text",
		role: "text",
		phone: "text",
		document: "text",
		hired_on: "date",
		contract: "text",
		pay_basis: "text",
		rate_cents: "bigint",
		pix_key: "text",
		active: "boolean",
		notes: "text"
	}, state.employees.map((item) => ({
		id: item.id,
		company_id,
		name: item.name,
		role: item.role,
		phone: item.phone,
		document: item.document,
		hired_on: item.hiredOn,
		contract: item.contract,
		pay_basis: item.payBasis,
		rate_cents: item.rateCents,
		pix_key: item.pixKey,
		active: item.active,
		notes: item.notes
	})));
	await insertMany(sql, "employee_entries", {
		id: "uuid",
		company_id: "uuid",
		employee_id: "uuid",
		kind: "text",
		entry_date: "date",
		quantity: "numeric",
		amount_cents: "bigint",
		project_id: "uuid",
		note: "text",
		account_id: "uuid",
		created_by: "uuid"
	}, state.employeeEntries.map((item) => ({
		id: item.id,
		company_id,
		employee_id: item.employeeId,
		kind: item.kind,
		entry_date: item.date,
		quantity: decimal(item.quantityMilli),
		amount_cents: item.amountCents,
		project_id: item.projectId,
		note: item.note,
		account_id: item.accountId,
		created_by: scope.userId
	})));
	await insertMany(sql, "payment_reversals", {
		id: "uuid",
		company_id: "uuid",
		payment_id: "uuid",
		reason: "text",
		created_by: "uuid",
		reversed_on: "date"
	}, state.reversals.map((item) => ({
		id: item.id,
		company_id,
		payment_id: item.paymentId,
		reason: item.reason,
		created_by: scope.userId,
		reversed_on: item.reversedOn
	})));
	await insertMany(sql, "receivables", {
		id: "uuid",
		company_id: "uuid",
		customer_id: "uuid",
		customer_name: "text",
		description: "text",
		amount_cents: "bigint",
		due_on: "date",
		received_on: "date",
		method: "text",
		account_id: "uuid",
		created_by: "uuid"
	}, state.charges.map((item) => ({
		id: item.id,
		company_id,
		customer_id: item.customerId,
		customer_name: item.customerName,
		description: item.description,
		amount_cents: item.amountCents,
		due_on: item.dueOn,
		received_on: item.receivedOn,
		method: item.method,
		account_id: item.accountId,
		created_by: scope.userId
	})));
	await insertMany(sql, "material_reservations", {
		id: "uuid",
		company_id: "uuid",
		project_id: "uuid",
		product_id: "uuid",
		quantity: "numeric",
		reserved_on: "date"
	}, state.reservations.map((item) => ({
		id: item.id,
		company_id,
		project_id: item.projectId,
		product_id: item.productId,
		quantity: decimal(item.quantityMilli),
		reserved_on: item.reservedOn
	})));
	await insertMany(sql, "receipts", {
		id: "uuid",
		company_id: "uuid",
		number: "integer",
		kind: "text",
		issued_on: "date",
		party: "text",
		party_document: "text",
		customer_id: "uuid",
		employee_id: "uuid",
		amount_cents: "bigint",
		reference: "text",
		method: "text",
		payment_id: "uuid",
		notes: "text",
		created_by: "uuid",
		deductions: "jsonb"
	}, state.receipts.map((item) => ({
		deductions: item.deductions,
		id: item.id,
		company_id,
		number: item.number,
		kind: item.kind,
		issued_on: item.issuedOn,
		party: item.party,
		party_document: item.partyDocument,
		customer_id: item.customerId,
		employee_id: item.employeeId,
		amount_cents: item.amountCents,
		reference: item.reference,
		method: item.method,
		payment_id: item.paymentId,
		notes: item.notes,
		created_by: scope.userId
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
/** Vendas não vê custo quando a empresa ligou a opção no painel. */
async function costsHidden(sql, context) {
	if (context.role !== "sales") return false;
	const [row] = await sql.query("select settings from company_settings where company_id=$1", [context.companyId]);
	return CompanySettingsSchema.parse(row?.settings ?? {}).hideCostFromSales;
}
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const linkHash = (token) => createHash("sha256").update(token).digest("hex");
const inviteHash = (code) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
/** Recusa vinda das funções do banco vira resposta clara (sem permissão, conflito, não encontrado). */
async function fromDatabase(query) {
	try {
		return await query;
	} catch (cause) {
		const code = cause.code, message = cause instanceof Error ? cause.message : "Não foi possível concluir.";
		if (code === "42501") throw new AppError("FORBIDDEN", message, 403);
		if (code === "23514") throw new AppError("TEAM", message, 409);
		if (code === "P0002") throw new AppError("NOT_FOUND", message, 404);
		throw cause;
	}
}
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
		return this.scoped(actor, companyId, null, async (sql, context) => {
			const state = await loadState(sql, companyId, today());
			return await costsHidden(sql, context) ? stripCosts(state) : state;
		});
	}
	/** Só o último mês (a janela do aparelho), com o que passou dobrado em saldo: o celular abre sem baixar o histórico. */
	async commercialWindow(actor, companyId) {
		return this.scoped(actor, companyId, null, async (sql, context) => {
			const window = await loadWindow(sql, companyId, today());
			return await costsHidden(sql, context) ? {
				...window,
				state: stripCosts(window.state)
			} : window;
		});
	}
	/**
	* Grava um comando lendo só a parte do estado que ele usa e travando só o registro dele (a obra, o orçamento, o
	* produto...): 30 pessoas mexendo em coisas diferentes gravam ao mesmo tempo, e duas no mesmo registro vão uma
	* depois da outra. Quem espera mais de 10 s desiste com 503 e o aparelho tenta de novo sozinho (fila sem internet).
	* Responde o estado inteiro ou, com reply 'patch', só o que mudou (o que o site usa).
	*/
	async commercialCommand(actor, companyId, command, reply = "state") {
		return this.scoped(actor, companyId, writers, async (sql, context) => {
			if (!canRun(context.role, command)) throw new AppError("FORBIDDEN", forbiddenMessage(context.role, command), 403);
			await sql.query("set local lock_timeout = '10s'");
			if (command.type === "saveQuote") command = await freeQuoteCode(sql, companyId, command);
			const { slice, lock } = commandSlice(command);
			await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [companyId + ":" + lock]);
			const before = await loadState(sql, companyId, today(), slice);
			const hidden = await costsHidden(sql, context);
			const allowed = hidden ? restoreCosts(command, before) : command;
			const after = applyCommercialCommand(before, allowed);
			await persistCommand(sql, context, before, after, allowed);
			if (reply === "patch") return hidden ? diffStates(stripCosts(before), stripCosts(after)) : diffStates(before, after);
			const state = await loadState(sql, companyId, today());
			return hidden ? stripCosts(state) : state;
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
	/** Link da proposta para o cliente: código longo e aleatório (o banco guarda o hash), vale 180 dias (a negociação de
	* cliente corporativo passa de um mês; a proposta vencida ainda pode ser aceita, e a equipe confere ao aprovar). */
	async createQuoteLink(actor, companyId, quoteId) {
		return this.scoped(actor, companyId, writers, async (sql, context) => {
			const [quote] = await sql.query("select status from commercial_quotes where company_id=$1 and id=$2", [companyId, quoteId]);
			if (!quote) throw new AppError("NOT_FOUND", "Orçamento não encontrado.", 404);
			if (!["draft", "sent"].includes(quote.status)) throw new AppError("QUOTE_CLOSED", "Só a proposta em aberto vai para o cliente aceitar.", 409);
			const token = randomBytes(24).toString("base64url");
			const expiresAt = new Date(Date.now() + 15552e6).toISOString();
			await sql.query("insert into quote_links(token_hash,company_id,quote_id,created_by,expires_at) values($1,$2,$3,$4,$5)", [
				linkHash(token),
				companyId,
				quoteId,
				context.userId,
				expiresAt
			]);
			return {
				token,
				expiresAt
			};
		});
	}
	/** A proposta como o cliente vê pelo link (sem login); nula quando o link não existe ou venceu. */
	async publicProposal(token) {
		return this.database.transaction(async (sql) => {
			const [row] = await sql.query("select praiamar_public_proposal($1) as data", [linkHash(token)]);
			return row?.data ? PublicProposalSchema.parse(row.data) : null;
		});
	}
	/** Aceite do cliente pelo link: devolve como ficou (aceita, vencida, aprovada, não fechada). */
	async acceptPublicProposal(token, name) {
		return this.database.transaction(async (sql) => {
			const [row] = await sql.query("select praiamar_public_accept($1,$2) as status", [linkHash(token), name]);
			return { status: row?.status ?? "expired" };
		});
	}
	/** Equipe (administrador e gestor veem; os outros recebem a lista vazia). */
	async team(actor, companyId) {
		return this.scoped(actor, companyId, null, async (sql, context) => (await sql.query("select user_id,name,role,active from praiamar_company_members()")).map((row) => TeamMemberSchema.parse({
			userId: row.user_id,
			name: row.name,
			role: row.role,
			active: row.active,
			self: row.user_id === context.userId
		})));
	}
	/** Muda a função ou desliga o acesso de alguém da equipe (só o administrador, nunca o próprio acesso). */
	async setMember(actor, companyId, userId, role, active) {
		return this.scoped(actor, companyId, ["admin"], async (sql, context) => {
			await fromDatabase(sql.query("select praiamar_set_member($1,$2,$3)", [
				userId,
				role,
				active
			]));
			await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'team.member',$3,$4::text::jsonb)", [
				companyId,
				context.userId,
				userId,
				JSON.stringify({
					role,
					active
				})
			]);
			return {
				userId,
				role,
				active
			};
		});
	}
	/** Convite: código curto de uso único (o banco guarda só o hash), com a função de quem vai entrar. */
	async createInvite(actor, companyId, role) {
		return this.scoped(actor, companyId, ["admin", "manager"], async (sql) => {
			const code = Array.from({ length: 10 }, () => inviteAlphabet[randomInt(32)]).join("");
			const [row] = await fromDatabase(sql.query("select praiamar_create_invite($1,$2) as expires", [inviteHash(code), role]));
			return {
				code: code.slice(0, 5) + "-" + code.slice(5),
				role,
				expiresAt: new Date(row.expires).toISOString()
			};
		});
	}
	/** Quem recebeu o código entra na empresa com a função do convite. */
	async acceptInvite(actor, code) {
		return this.personal(actor, async (sql) => {
			const [row] = await fromDatabase(sql.query("select praiamar_accept_invite($1,$2) as id", [inviteHash(code), (actor.name ?? "Usuário").slice(0, 160)]));
			return { companyId: row.id };
		});
	}
	/** Logo da empresa (cabeçalho da proposta e do recibo); nulo quando não há. */
	async companyLogo(actor, companyId) {
		return this.scoped(actor, companyId, null, async (sql) => {
			const [row] = await sql.query("select image from company_logos where company_id=$1", [companyId]);
			return { image: row?.image ?? null };
		});
	}
	/** Põe, troca ou tira o logo: só administrador e gestor, como os outros dados da empresa. */
	async saveCompanyLogo(actor, companyId, image) {
		return this.scoped(actor, companyId, ["admin", "manager"], async (sql, context) => {
			if (image) await sql.query("insert into company_logos(company_id,image) values($1,$2) on conflict (company_id) do update set image=excluded.image,updated_at=now()", [companyId, image]);
			else await sql.query("delete from company_logos where company_id=$1", [companyId]);
			await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'company.logo',$1,$3::text::jsonb)", [
				companyId,
				context.userId,
				JSON.stringify({ removed: !image })
			]);
			return { image };
		});
	}
	/** Fotos do projeto (medição, obra, montagem), da mais antiga à mais nova. */
	async projectPhotos(actor, companyId, projectId) {
		return this.scoped(actor, companyId, null, async (sql) => (await sql.query("select id,image from project_photos where company_id=$1 and project_id=$2 order by created_at,id", [companyId, projectId])).map((row) => ({
			id: row.id,
			projectId,
			image: row.image
		})));
	}
	async addProjectPhoto(actor, companyId, projectId, id, image) {
		return this.scoped(actor, companyId, writers, async (sql, context) => {
			const [project] = await sql.query("select 1 from projects where company_id=$1 and id=$2", [companyId, projectId]);
			if (!project) throw new AppError("NOT_FOUND", "Projeto não encontrado.", 404);
			const [{ count } = { count: 0 }] = await sql.query("select count(*)::int as count from project_photos where company_id=$1 and project_id=$2", [companyId, projectId]);
			if (count >= 30) throw new AppError("PHOTOS", "O projeto já tem 30 fotos. Tire alguma antes.", 400);
			await sql.query("insert into project_photos(id,company_id,project_id,image) values($1,$2,$3,$4) on conflict (id) do nothing", [
				id,
				companyId,
				projectId,
				image
			]);
			await sql.query("insert into audit_events(company_id,actor_id,action,entity_id,payload) values($1,$2,'project.photo',$3,'{}'::jsonb)", [
				companyId,
				context.userId,
				projectId
			]);
			return {
				id,
				projectId,
				image
			};
		});
	}
	async deleteProjectPhoto(actor, companyId, projectId, id) {
		return this.scoped(actor, companyId, writers, async (sql) => {
			await sql.query("delete from project_photos where company_id=$1 and project_id=$2 and id=$3", [
				companyId,
				projectId,
				id
			]);
			return { id };
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
		methods: [
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"DELETE"
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
	app.get("/openapi.json", async () => openApi());
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
		const { state, company } = z.object({
			state: z.enum(["1", "window"]).optional(),
			company: z.union([z.uuid(), z.literal("last")]).optional()
		}).parse(request.query);
		const chosen = (company === "last" ? companies.at(-1) : companies.find((item) => item.id === company)) ?? companies[0];
		return {
			companies,
			assistant: Boolean(options.assistant),
			...state && chosen && {
				...state === "window" ? await service.commercialWindow(actor, chosen.id) : { state: await service.commercialState(actor, chosen.id) },
				stateCompany: chosen.id
			}
		};
	});
	app.post("/v1/companies", { bodyLimit: 4194304 }, async (request, reply) => {
		const actor = await identify(request.headers);
		const { name, example } = CreateCompanySchema.parse(request.body);
		return reply.code(201).send(await service.createCompany(actor, name, example));
	});
	app.get("/v1/commercial/state", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return request.query.window === "1" ? service.commercialWindow(actor, companyId) : service.commercialState(actor, companyId);
	});
	app.post("/v1/commercial/commands", async (request) => {
		const { actor, companyId } = await context(request.headers);
		const reply = request.query.reply === "patch" ? "patch" : "state";
		return service.commercialCommand(actor, companyId, CommercialCommandSchema.parse(request.body), reply);
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
	app.post("/v1/quotes/:id/link", async (request, reply) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return reply.code(201).send(await service.createQuoteLink(actor, companyId, id));
	});
	const token = z.object({ token: ProposalTokenSchema });
	app.get("/v1/public/proposals/:token", { config: { rateLimit: {
		max: 60,
		timeWindow: "1 minute"
	} } }, async (request) => {
		const proposal = await service.publicProposal(token.parse(request.params).token);
		if (!proposal) throw new AppError("NOT_FOUND", "Este link não existe ou já venceu. Peça um novo à empresa.", 404);
		return proposal;
	});
	app.post("/v1/public/proposals/:token/accept", { config: { rateLimit: {
		max: 10,
		timeWindow: "1 minute"
	} } }, async (request) => {
		const { name } = PublicAcceptSchema.parse(request.body);
		return service.acceptPublicProposal(token.parse(request.params).token, name);
	});
	app.get("/v1/team", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.team(actor, companyId);
	});
	app.put("/v1/team/:userId", async (request) => {
		const { actor, companyId } = await context(request.headers), { userId } = z.object({ userId: z.uuid() }).parse(request.params), body = TeamMemberSchema.pick({
			role: true,
			active: true
		}).strict().parse(request.body);
		return service.setMember(actor, companyId, userId, body.role, body.active);
	});
	app.post("/v1/team/invites", async (request, reply) => {
		const { actor, companyId } = await context(request.headers), { role } = TeamMemberSchema.pick({ role: true }).strict().parse(request.body);
		return reply.code(201).send(await service.createInvite(actor, companyId, role));
	});
	app.post("/v1/invites/accept", { config: { rateLimit: {
		max: 10,
		timeWindow: "1 minute"
	} } }, async (request) => {
		const actor = await identify(request.headers), { code } = InviteAcceptSchema.parse(request.body);
		return service.acceptInvite(actor, code);
	});
	app.get("/v1/company/logo", async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.companyLogo(actor, companyId);
	});
	app.put("/v1/company/logo", { bodyLimit: 1048576 }, async (request) => {
		const { actor, companyId } = await context(request.headers);
		return service.saveCompanyLogo(actor, companyId, CompanyLogoSchema.parse(request.body).image);
	});
	app.get("/v1/projects/:id/photos", async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params);
		return service.projectPhotos(actor, companyId, id);
	});
	app.post("/v1/projects/:id/photos", { bodyLimit: 1048576 }, async (request) => {
		const { actor, companyId } = await context(request.headers), { id } = z.object({ id: z.uuid() }).parse(request.params), body = ProjectPhotoSchema.parse({
			...request.body,
			projectId: id
		});
		return service.addProjectPhoto(actor, companyId, id, body.id, body.image);
	});
	app.delete("/v1/projects/:id/photos/:photo", async (request) => {
		const { actor, companyId } = await context(request.headers), params = z.object({
			id: z.uuid(),
			photo: z.uuid()
		}).parse(request.params);
		return service.deleteProjectPhoto(actor, companyId, params.id, params.photo);
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
const response = ServerResponse.prototype;
if (response._hasBody === void 0) response._hasBody = true;
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
