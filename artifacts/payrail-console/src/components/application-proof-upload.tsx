import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2, Upload } from "lucide-react";
import {
  getListMerchantApplicationAttachmentsQueryKey,
  useAddMerchantApplicationAttachments,
  useCreateMerchantApplicationAttachmentUploadIntent,
  useDeleteMerchantApplicationAttachmentUploadIntent,
} from "@workspace/api-client-react";
import { Btn, Card, Err, Field, Note } from "@/components/kit";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
type SupportedType = "application/pdf" | "image/png" | "image/jpeg";

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

export function ApplicationProofUpload() {
  const queryClient = useQueryClient();
  const createUploadIntent = useCreateMerchantApplicationAttachmentUploadIntent();
  const deleteUploadIntent = useDeleteMerchantApplicationAttachmentUploadIntent();
  const attachFiles = useAddMerchantApplicationAttachments();
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ key: string; token: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setError("");
    setSuccess("");
    if (selected.length > MAX_FILES) {
      setError("Choose no more than five files at a time.");
      return;
    }
    const invalid = selected.find((file) =>
      file.size > MAX_FILE_BYTES ||
      !["application/pdf", "image/png", "image/jpeg"].includes(file.type),
    );
    if (invalid) {
      setError(`${invalid.name}: choose a PDF, PNG, or JPEG file no larger than 10 MB.`);
      return;
    }
    setFiles(selected);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!files.length) {
      setError("Choose at least one document to upload.");
      return;
    }
    setUploading(true);
    try {
      const tokens: string[] = [];
      for (const file of files) {
        const key = fileKey(file);
        const existing = uploadedFiles.find((uploaded) => uploaded.key === key);
        if (existing) {
          tokens.push(existing.token);
          continue;
        }
        const intent = await createUploadIntent.mutateAsync({ data: {
          name: file.name,
          size: file.size,
          contentType: file.type as SupportedType,
        } });
        const body = new FormData();
        for (const [field, value] of Object.entries(intent.uploadParameters)) body.append(field, value);
        body.append("file", file);
        try {
          const response = await fetch(intent.uploadURL, { method: "POST", body });
          if (!response.ok) throw new Error(`Private upload failed for ${file.name} (${response.status}).`);
        } catch (failure) {
          await deleteUploadIntent.mutateAsync({ uploadToken: intent.uploadToken }).catch(() => undefined);
          throw failure;
        }
        setUploadedFiles((current) => [...current, { key, token: intent.uploadToken }]);
        tokens.push(intent.uploadToken);
      }
      await attachFiles.mutateAsync({ data: { uploadTokens: tokens } });
      setFiles([]);
      setUploadedFiles([]);
      setSuccess("Your private address documents were added to the application.");
      await queryClient.invalidateQueries({ queryKey: getListMerchantApplicationAttachmentsQueryKey() });
    } catch (failure) {
      setError(String((failure as Error).message || "The documents could not be attached. Try again."));
    } finally {
      setUploading(false);
    }
  }

  function removeFile(file: File) {
    const key = fileKey(file);
    const uploaded = uploadedFiles.find((item) => item.key === key);
    setFiles((current) => current.filter((item) => item !== file));
    setUploadedFiles((current) => current.filter((item) => item.key !== key));
    if (uploaded) {
      void deleteUploadIntent.mutateAsync({ uploadToken: uploaded.token }).catch(() => {
        setError("The file was removed from this form, but its temporary upload could not be canceled.");
      });
    }
  }

  return <Card title="Add proof of address" subtitle="Optional supporting documents for your pending manual address review.">
    <div className="form-stack">
      <Note>Upload a document that supports the registered address. Files are private and available only to you and authorized Greenpay reviewers.</Note>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Address documents" hint="PDF, PNG, or JPEG · up to five files · 10 MB each">
          <input
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg"
            disabled={uploading}
            onChange={selectFiles}
            data-testid="input-address-proof-files"
          />
        </Field>
        {files.map((file) => {
          const uploaded = uploadedFiles.some((item) => item.key === fileKey(file));
          return <div className="row-actions" key={fileKey(file)}>
            <span>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB{uploaded ? " · uploaded privately" : ""}</span>
            <Btn
              type="button"
              variant="secondary"
              small
              disabled={uploading}
              onClick={() => removeFile(file)}
              testId={`button-remove-address-proof-${file.name}`}
            >
              <Trash2 size={13} />Remove
            </Btn>
          </div>;
        })}
        {error && <Err error={error} />}
        {success && <Note>{success}</Note>}
        <Btn type="submit" disabled={uploading || !files.length} testId="button-upload-address-proof">
          {uploading ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}
          {uploading ? "Uploading documents…" : "Upload proof of address"}
        </Btn>
      </form>
    </div>
  </Card>;
}