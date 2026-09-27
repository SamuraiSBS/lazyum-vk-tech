import { NextResponse } from "next/server";
import { ArtifactNotFoundError, createArtifactStore } from "../../../../../lib/artifact-store";

export const runtime = "nodejs";

type ArtifactRouteContext = {
  params: Promise<{ jobId: string; path: string[] }>;
};

export async function GET(_request: Request, { params }: ArtifactRouteContext) {
  const { jobId, path: pathSegments } = await params;
  if (!pathSegments?.length) return NextResponse.json({ error: "Artifact path is required" }, { status: 404 });

  try {
    const artifact = await createArtifactStore().readPublishedArtifact(jobId, pathSegments.join("/"));
    return new Response(new Uint8Array(artifact.contents), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(artifact.contents.byteLength),
        "Content-Type": contentTypeFor(artifact.relativePath),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ArtifactNotFoundError || error instanceof Error) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
}

function contentTypeFor(relativePath: string) {
  const extension = relativePath.toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "pdf") return "application/pdf";
  if (extension === "html") return "text/html; charset=utf-8";
  if (extension === "json") return "application/json; charset=utf-8";
  if (extension === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}
