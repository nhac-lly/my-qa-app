import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  outputFileTracingExcludes: {
    '/': [
      'node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/!(libonnxruntime.so.1|onnxruntime_binding.node)',
    ],
},
};

export default nextConfig;
