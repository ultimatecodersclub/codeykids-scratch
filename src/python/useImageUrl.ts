import { useEffect, useMemo } from "react";

// An object URL for a picture file's bytes, released when the file changes or
// the editor moves to another file. Undefined for anything that is not a
// picture.
export const useImageUrl = (bytes: Uint8Array | undefined, type: string | undefined) => {
  const url = useMemo(
    () => (bytes && type ? URL.createObjectURL(new Blob([bytes as BlobPart], { type })) : undefined),
    [bytes, type],
  );

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  return url;
};
