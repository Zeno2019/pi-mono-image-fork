import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IMAGE_AUTH_PROVIDER } from "../src/image-oauth.js";
import { decodeImageData, requestImage, resolveImageAuth } from "./index.js";

export { imageAuthProvider } from "../src/image-oauth.js";

export interface HostedImageParameters {
	prompt: string;
	outputFormat?: "png" | "jpeg" | "webp";
}

/** A trusted host owns authorization, reference snapshots, and durable storage. */
export interface HostedImageHost<Result> {
	model: string;
	prepare(toolCallId: string, branchId: string, signal?: AbortSignal): Promise<{
		operationId: string;
		referenceImages: Array<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
	}>;
	beforeRequest(input: { operationId: string; toolCallId: string }, signal?: AbortSignal): Promise<void>;
	persist(input: {
		operationId: string;
		toolCallId: string;
		bytes: Uint8Array;
		mimeType: string;
		responseId?: string;
		imageGenerationId?: string;
	}): Promise<Result>;
	fetch?: typeof fetch;
	authenticate?: (registry: ExtensionContext["modelRegistry"], signal?: AbortSignal) => Promise<{ token: string; accountId: string }>;
}

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

function inputImages(images: Awaited<ReturnType<HostedImageHost<unknown>["prepare"]>>["referenceImages"]) {
	if (!Array.isArray(images) || images.length > 5) throw new Error("Reference images accept at most five images.");
	let total = 0;
	return images.map((image) => {
		if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength > 20 * 1024 * 1024) throw new Error("Reference image exceeds 20 MiB or has invalid bytes.");
		total += image.bytes.byteLength;
		if (total > 50 * 1024 * 1024) throw new Error("Reference images exceed 50 MiB in total.");
		const format = OUTPUT_FORMATS.find((value) => `image/${value}` === image.mimeType);
		if (!format) throw new Error("Reference image has an unsupported format.");
		const data = Buffer.from(image.bytes).toString("base64");
		decodeImageData(data, format);
		return { data, mimeType: image.mimeType };
	});
}

/** No tool registration, configuration/path I/O, telemetry, or image-request retries. */
export function createHostedImageGenerator<Result>(host: HostedImageHost<Result>) {
	if (typeof host.model !== "string" || !host.model.trim() || host.model.length > 200 || host.model.startsWith("gpt-image-")) throw new Error("The image host routing model is invalid.");
	return async function generate(toolCallId: string, params: HostedImageParameters, branchId: string,
		registry: ExtensionContext["modelRegistry"], signal?: AbortSignal) {
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Image parameters must be an object.");
		if (Object.keys(params).some((key) => key !== "prompt" && key !== "outputFormat")) throw new Error("Unknown image parameter.");
		if (typeof params.prompt !== "string" || !params.prompt.trim() || params.prompt.length > 32_000) throw new Error("Image prompt must contain 1 to 32,000 characters.");
		const outputFormat = params.outputFormat ?? "png";
		if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error("Unsupported image output format.");
		let prepared: Awaited<ReturnType<HostedImageHost<Result>["prepare"]>>;
		try {
			prepared = await host.prepare(toolCallId, branchId, signal);
		} catch {
			throw new Error("Image host preparation failed. No image request was made.");
		}
		const references = inputImages(prepared.referenceImages);
		signal?.throwIfAborted();
		let credentials: { token: string; accountId: string };
		try {
			credentials = host.authenticate
				? await host.authenticate(registry, signal)
				: await resolveImageAuth(registry, false);
		} catch {
			throw new Error("Image authentication failed. Run /login codex-images. No image request was made.");
		}
		signal?.throwIfAborted();
		try {
			await host.beforeRequest({ operationId: prepared.operationId, toolCallId }, signal);
		} catch {
			throw new Error("Image host request authorization failed. No image request was made.");
		}
		signal?.throwIfAborted();
		let parsed: Awaited<ReturnType<typeof requestImage>>;
		try {
			parsed = await requestImage(params, { ...credentials, provider: IMAGE_AUTH_PROVIDER }, host.model,
				outputFormat, prepared.operationId, references, signal, undefined, { fetch: host.fetch, maxRetries: 0 });
		} catch {
			throw new Error("Image request failed or was interrupted. No automatic retry was made; image quota may already have been consumed.");
		}
		if (!parsed.image) throw new Error("Codex did not return an image. No automatic retry was made.");
		const bytes = decodeImageData(parsed.image.result, outputFormat);
		const mimeType = `image/${outputFormat}`;
		let persisted: Result;
		try {
			// A completed image must reach durable storage even if cancellation arrives now.
			persisted = await host.persist({ operationId: prepared.operationId, toolCallId, bytes, mimeType,
				responseId: parsed.responseId, imageGenerationId: parsed.image.id });
		} catch {
			throw new Error("Image generation completed, but durable storage failed. No automatic retry was made.");
		}
		return { operationId: prepared.operationId, bytes, data: parsed.image.result, mimeType, persisted,
			responseId: parsed.responseId, imageGenerationId: parsed.image.id };
	};
}
