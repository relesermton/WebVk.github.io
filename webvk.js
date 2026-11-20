/**
 * src/webvk.js — WebVk's public API: *vulkan.h recoded to .js*.
 *
 * The wasm-gc core (src/core.mjs → dist/webvk.wasm) speaks raw i32:
 * handles, packed create-infos in linear memory, bit-cast floats. This
 * file is the layer a Vulkan programmer recognizes:
 *
 *   - Vk*   classes   — handle wrappers (VkInstance, VkBuffer, …) and
 *                       struct records with Vulkan field names/defaults
 *                       (VkViewport, VkRenderPassCreateInfo, …)
 *   - vk*   functions — the Vulkan entry points, same names and shapes
 *                       (vkCreateDevice, vkCmdDraw, vkQueueSubmit, …)
 *   - Vk*   constants — the enum/flag values the core actually consumes
 *   - the loader      — fetch + instantiate dist/webvk.wasm, wire Mem
 *   - the Viewport    — presentation: rasterized RGBA8 in linear memory
 *                       → <canvas> → captureStream() → loopback
 *                       RTCPeerConnection → <video>  (WebVk's
 *                       "swapchain presentation", implemented entirely
 *                       on the JS side; the core knows nothing about it)
 *
 * Design notes
 *   - Handles are i32 (0 == VK_NULL_HANDLE). Vk* wrapper classes carry
 *     the raw number; `h(x)` unwraps either a wrapper or a bare number,
 *     so both styles work at every call site.
 *   - Sizes that cross the ABI as i64 arrive here as JS numbers and are
 *     converted with BigInt() on the way in.
 *   - Floats (viewport, clear colors) are f32 parameters; push constants
 *     and pipeline create-infos are bytes in linear memory (Mem).
 *   - One host-visible "staging" allocation is created lazily per device
 *     and used as a per-call scratch for create-infos / out-params. It
 *     never nests: every vk* entry point resets the bump before use and
 *     the core copies everything out before returning.
 *
 * Sync model (see core.mjs): vkQueueSubmit replays synchronously and
 * vkQueuePresentKHR just flips the swapchain index — so after submit,
 * the frame is already in linear memory and the Viewport can blit it.
 */

import { Mem } from './mem.mjs';

/* ================================================================ enums */

/** 0 is VK_NULL_HANDLE everywhere in this API. */
export const VK_NULL_HANDLE = 0;

export const VkResult = {
  SUCCESS: 0,
  NOT_READY: 1,
  TIMEOUT: 2,
  EVENT_SET: 3,
  EVENT_RESET: 4,
  INCOMPLETE: 5,
  ERROR_OUT_OF_HOST_MEMORY: -1,
  ERROR_OUT_OF_DEVICE_MEMORY: -2,
  ERROR_INITIALIZATION_FAILED: -3,
  ERROR_DEVICE_LOST: -4,
  ERROR_MEMORY_MAP_FAILED: -5,
  ERROR_LAYER_NOT_PRESENT: -6,
  ERROR_EXTENSION_NOT_PRESENT: -7,
  ERROR_FEATURE_NOT_PRESENT: -8,
  ERROR_INCOMPATIBLE_DRIVER: -9,
  ERROR_TOO_MANY_OBJECTS: -10,
  ERROR_FORMAT_NOT_SUPPORTED: -11,
  ERROR_FRAGMENTED_POOL: -12,
  ERROR_UNKNOWN: -13,
};

export const VkFormat = {
  UNDEFINED: 0,
  R8G8B8A8_UNORM: 37,
  B8G8R8A8_UNORM: 44,
  R16G16B16A16_SFLOAT: 97,
  R32_SFLOAT: 100,
  R32G32_SFLOAT: 103,
  R32G32B32_SFLOAT: 106,
  R32G32B32A32_SFLOAT: 109,
  D16_UNORM: 124,
  D32_SFLOAT: 126,
  D32_SFLOAT_S8_UINT: 130,
};

export const VkAttachmentLoadOp = { CLEAR: 0, LOAD: 1, DONT_CARE: 2 };
export const VkAttachmentStoreOp = { STORE: 0, DONT_CARE: 1 };

/** VkImageLayout — only finalLayout is passed through by the core today */
export const VkImageLayout = {
  UNDEFINED: 0,
  GENERAL: 1,
  COLOR_ATTACHMENT_OPTIMAL: 2,
  DEPTH_STENCIL_ATTACHMENT_OPTIMAL: 3,
  TRANSFER_SRC_OPTIMAL: 5,
  TRANSFER_DST_OPTIMAL: 6,
  PREINITIALIZED: 7,
  PRESENT_SRC_KHR: 1000001002,
};

export const VkImageUsageFlag = {
  TRANSFER_SRC: 0x00000001,
  TRANSFER_DST: 0x00000002,
  SAMPLED: 0x00000004,
  STORAGE: 0x00000008,
  COLOR_ATTACHMENT: 0x00000010,
  DEPTH_STENCIL_ATTACHMENT: 0x00000020,
};

export const VkBufferUsageFlag = {
  TRANSFER_SRC: 0x00000001,
  TRANSFER_DST: 0x00000002,
  UNIFORM_BUFFER: 0x00000010,
  STORAGE_BUFFER: 0x00000020,
  INDEX_BUFFER: 0x00000040,
  VERTEX_BUFFER: 0x00000080,
};

export const VkMemoryPropertyFlag = {
  DEVICE_LOCAL: 0x00000001,
  HOST_VISIBLE: 0x00000002,
  HOST_COHERENT: 0x00000004,
  HOST_CACHED: 0x00000008,
};

export const VkImageAspectFlag = { COLOR: 1, PLANE_0: 4, DEPTH: 2, STENCIL: 8 };

export const VkPrimitiveTopology = {
  POINT_LIST: 0,
  LINE_LIST: 1,
  LINE_STRIP: 2,
  TRIANGLE_LIST: 3,
  TRIANGLE_STRIP: 4,
  TRIANGLE_FAN: 5,
};

/* NOTE: the core's op table uses its own compact topology ids for the
 * rasterizer (0 = triangle list). VkPrimitiveTopology above is the real
 * Vulkan numbering; VkPipelineCreateInfo.topology takes the *core* id —
 * use VkCoreTopology below, which is what the wasm actually decodes. */
export const VkCoreTopology = { TRIANGLE_LIST: 0, LINE_LIST: 1, POINT_LIST: 2 };

export const VkPolygonMode = { FILL: 0, LINE: 1, POINT: 2 };
export const VkCullModeFlag = { NONE: 0, FRONT: 1, BACK: 2, FRONT_AND_BACK: 3 };
export const VkFrontFace = { COUNTER_CLOCKWISE: 0, CLOCKWISE: 1 };

export const VkCompareOp = {
  NEVER: 0,
  LESS: 1,
  EQUAL: 2,
  LESS_OR_EQUAL: 3,
  GREATER: 4,
  NOT_EQUAL: 5,
  GREATER_OR_EQUAL: 6,
  ALWAYS: 7,
};

export const VkBlendFactor = {
  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 2,
  ONE_MINUS_SRC_COLOR: 3,
  DST_COLOR: 4,
  ONE_MINUS_DST_COLOR: 5,
  SRC_ALPHA: 6,
  ONE_MINUS_SRC_ALPHA: 7,
  DST_ALPHA: 8,
  ONE_MINUS_DST_ALPHA: 9,
  CONSTANT_COLOR: 10,
  ONE_MINUS_CONSTANT_COLOR: 11,
  CONSTANT_ALPHA: 12,
  ONE_MINUS_CONSTANT_ALPHA: 13,
};

export const VkBlendOp = {
  ADD: 0,
  SUBTRACT: 1,
  REVERSE_SUBTRACT: 2,
  MIN: 3,
  MAX: 4,
};

export const VkColorComponentFlag = { R: 1, G: 2, B: 4, A: 8, RGBA: 15 };

export const VkShaderStageFlag = {
  VERTEX: 0x00000001,
  TESSELLATION_CONTROL: 0x00000002,
  TESSELLATION_EVALUATION: 0x00000004,
  GEOMETRY: 0x00000008,
  FRAGMENT: 0x00000010,
  COMPUTE: 0x00000020,
  ALL_GRAPHICS: 0x0000001f,
  ALL: 0x7fffffff,
};

export const VkCommandBufferLevel = { PRIMARY: 0, SECONDARY: 1 };

export const VkSharingMode = { EXCLUSIVE: 0, CONCURRENT: 1 };

export const VkPresentModeKHR = {
  IMMEDIATE: 0,
  MAILBOX: 1,
  FIFO: 2,
  FIFO_RELAXED: 3,
};

/**
 * Built-in shader ids. The core has no shader compiler: the rasterizer
 * *is* the shading stage, and shader modules record which built-in to
 * use (the vertex fetch + MVP transform, the interpolated colour path).
 */
export const VkBuiltinShader = {
  VERTEX_COLOR_VS: 1, // transform position, pass vertex colour through
  INTERPOLATED_FS: 2, // perspective-correct per-channel interpolation
};

/** keys for vkGetStat / wvk_stat */
export const VkStat = {
  GC_OBJECTS: 0,
  CMDS_EXECUTED: 1,
  DRAW_CALLS: 2,
  TRIANGLES: 3,
  VERTICES: 4,
  PIXELS_SHADED: 5,
  PRESENTS: 6,
  SUBMITS: 7,
  OBJECTS_ALIVE: 8,
  MEM_TOP: 9,
};

/* ============================================================== handles */

/** Base for every Vk* handle wrapper: an i32 with a Vulkan type name. */
export class VkHandle {
  constructor(handle, type) {
    this.handle = handle | 0;
    this.type = type;
  }
  /** lets a wrapper slip into any numeric slot (WebAssembly coerces it) */
  valueOf() { return this.handle; }
  get isNull() { return this.handle === 0; }
  toString() { return `${this.type}(${this.handle})`; }
}

/** unwrap a VkHandle or a bare number to the raw i32 */
const h = (x) => (x instanceof VkHandle ? x.handle : (x | 0));

const handleClass = (name) =>
  class extends VkHandle {
    constructor(handle) { super(handle, name); }
  };

export const VkInstance = handleClass('VkInstance');
export const VkPhysicalDevice = handleClass('VkPhysicalDevice');
export const VkDevice = handleClass('VkDevice');
export const VkQueue = handleClass('VkQueue');
export const VkDeviceMemory = handleClass('VkDeviceMemory');
export const VkBuffer = handleClass('VkBuffer');
export const VkImage = handleClass('VkImage');
export const VkImageView = handleClass('VkImageView');
export const VkRenderPass = handleClass('VkRenderPass');
export const VkFramebuffer = handleClass('VkFramebuffer');
export const VkShaderModule = handleClass('VkShaderModule');
export const VkPipelineLayout = handleClass('VkPipelineLayout');
export const VkPipeline = handleClass('VkPipeline');
export const VkCommandPool = handleClass('VkCommandPool');
export const VkCommandBuffer = handleClass('VkCommandBuffer');
export const VkFence = handleClass('VkFence');
export const VkSemaphore = handleClass('VkSemaphore');
export const VkSurfaceKHR = handleClass('VkSurfaceKHR');
export const VkSwapchainKHR = handleClass('VkSwapchainKHR');

/* ============================================================== structs */

/** helper: merge a plain object over a struct class's defaults */
const info = (Cls, raw) => Object.assign(new Cls(), raw);

export class VkExtent2D {
  constructor(width = 0, height = 0) { this.width = width; this.height = height; }
}

export class VkRect2D {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.offset = { x, y };
    this.extent = { width, height };
  }
}

export class VkViewport {
  constructor(x = 0, y = 0, width = 0, height = 0, minDepth = 0, maxDepth = 1) {
    this.x = x; this.y = y;
    this.width = width; this.height = height;
    this.minDepth = minDepth; this.maxDepth = maxDepth;
  }
}

export class VkClearColorValue {
  /** @param {number[]} rgba 0..1 components */
  constructor(rgba = [0, 0, 0, 1]) { this.float32 = rgba.slice(0, 4); }
  static rgb(r, g, b, a = 1) { return new VkClearColorValue([r, g, b, a]); }
}

export class VkClearDepthStencilValue {
  constructor(depth = 1, stencil = 0) { this.depth = depth; this.stencil = stencil; }
}

export class VkApplicationInfo {
  constructor(raw = {}) {
    this.applicationName = raw.applicationName ?? 'webvk-app';
    this.engineName = raw.engineName ?? 'webvk-core';
    this.apiVersion = raw.apiVersion ?? 0x00404000; // Vulkan 1.0
    this.applicationVersion = raw.applicationVersion ?? 1;
    this.engineVersion = raw.engineVersion ?? 1;
  }
}

export class VkInstanceCreateInfo {
  constructor(raw = {}) {
    this.enabledLayerCount = 0;
    this.ppEnabledLayerNames = [];
    this.enabledExtensionCount = 0;
    this.ppEnabledExtensionNames = [];
    this.flags = raw.flags ?? 0;
    this.pApplicationInfo = new VkApplicationInfo(raw.pApplicationInfo);
  }
}

export class VkDeviceCreateInfo {
  constructor(raw = {}) {
    this.flags = raw.flags ?? 0;
    this.queueCreateInfos = raw.queueCreateInfos ?? [{ queueFlags: 1, queueCount: 1 }];
    this.enabledExtensionCount = 0;
    this.ppEnabledExtensionNames = [];
    this.pEnabledFeatures = raw.pEnabledFeatures ?? null;
  }
}

export class VkSurfaceFormatKHR {
  constructor(format = VkFormat.R8G8B8A8_UNORM, colorSpace = 0) {
    this.format = format;
    this.colorSpace = colorSpace;
  }
}

export class VkSwapchainCreateInfoKHR {
  constructor(raw = {}) {
    this.flags = raw.flags ?? 0;
    this.surface = raw.surface ?? VK_NULL_HANDLE;
    this.minImageCount = raw.minImageCount ?? 2;
    this.imageFormat = raw.imageFormat ?? VkFormat.R8G8B8A8_UNORM;
    this.imageColorSpace = raw.imageColorSpace ?? 0;
    this.imageExtent = raw.imageExtent ?? new VkExtent2D(64, 64);
    this.imageUsage = raw.imageUsage ?? VkImageUsageFlag.COLOR_ATTACHMENT;
    this.preTransform = raw.preTransform ?? 0;
    this.compositeAlpha = raw.compositeAlpha ?? 0;
    this.presentMode = raw.presentMode ?? VkPresentModeKHR.FIFO;
    this.clipped = true;
    this.oldSwapchain = raw.oldSwapchain ?? VK_NULL_HANDLE;
  }
}

export class VkImageViewCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.image = raw.image ?? VK_NULL_HANDLE;
    this.viewType = raw.viewType ?? 0; // VK_IMAGE_VIEW_TYPE_2D
    this.format = raw.format ?? VkFormat.R8G8B8A8_UNORM;
    this.subresourceRange = {
      aspectMask: raw.aspectMask ?? VkImageAspectFlag.COLOR,
      baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1,
    };
  }
}

export class VkAttachmentDescription {
  constructor(raw = {}) {
    this.flags = 0;
    this.format = raw.format ?? VkFormat.R8G8B8A8_UNORM;
    this.samples = 1; // VK_SAMPLE_COUNT_1_BIT
    this.loadOp = raw.loadOp ?? VkAttachmentLoadOp.CLEAR;
    this.storeOp = raw.storeOp ?? VkAttachmentStoreOp.STORE;
    this.stencilLoadOp = VkAttachmentLoadOp.DONT_CARE;
    this.stencilStoreOp = VkAttachmentStoreOp.DONT_CARE;
    this.initialLayout = raw.initialLayout ?? VkImageLayout.UNDEFINED;
    this.finalLayout = raw.finalLayout ?? VkImageLayout.COLOR_ATTACHMENT_OPTIMAL;
  }
}

export class VkSubpassDescription {
  constructor(raw = {}) {
    this.pipelineBindPoint = 0; // GRAPHICS
    this.inputAttachmentCount = 0;
    this.colorAttachmentCount = 1;
    this.pColorAttachments = raw.pColorAttachments ?? [0];
    this.pResolveAttachments = null;
    this.pDepthStencilAttachment = raw.pDepthStencilAttachment ?? null;
    this.preserveAttachmentCount = 0;
  }
}

export class VkRenderPassCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.attachmentCount = 1;
    this.pAttachments = raw.pAttachments ?? [new VkAttachmentDescription()];
    this.subpassCount = 1;
    this.pSubpasses = raw.pSubpasses ?? [new VkSubpassDescription()];
    this.dependencyCount = 0;
    this.pDependencies = [];
  }
}

export class VkFramebufferCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.renderPass = raw.renderPass ?? VK_NULL_HANDLE;
    this.attachmentCount = raw.attachmentCount ?? 1;
    this.pAttachments = raw.pAttachments ?? []; // VkImageView[]
    this.width = raw.width ?? 0;
    this.height = raw.height ?? 0;
    this.layers = 1;
  }
}

export class VkShaderModuleCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.codeSize = raw.codeSize ?? 4;
    this.pCode = raw.pCode ?? null;
    this.stage = raw.stage ?? VkShaderStageFlag.VERTEX;
    this.builtin = raw.builtin ?? VkBuiltinShader.VERTEX_COLOR_VS;
  }
}

export class VkPushConstantRange {
  constructor(stageFlags = VkShaderStageFlag.ALL_GRAPHICS, offset = 0, size = 64) {
    this.stageFlags = stageFlags;
    this.offset = offset;
    this.size = size;
  }
}

export class VkPipelineLayoutCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.setLayoutCount = 0;
    this.pSetLayouts = [];
    this.pushConstantRangeCount = raw.pushConstantRangeCount ?? 1;
    this.pPushConstantRanges = raw.pPushConstantRanges ??
      [new VkPushConstantRange(raw.stageFlags, 0, raw.pushConstantSize ?? 64)];
  }
}

export class VkPipelineShaderStageCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.stage = raw.stage ?? VkShaderStageFlag.VERTEX;
    this.module = raw.module ?? VK_NULL_HANDLE;
    this.pName = 'main';
    this.pSpecializationInfo = null;
  }
}

export class VkVertexInputBindingDescription {
  constructor(raw = {}) {
    this.binding = raw.binding ?? 0;
    this.stride = raw.stride ?? 16;
    this.inputRate = raw.inputRate ?? 0; // VERTEX
  }
}

export class VkVertexInputAttributeDescription {
  constructor(raw = {}) {
    this.location = raw.location ?? 0;
    this.binding = raw.binding ?? 0;
    this.format = raw.format ?? VkFormat.R32G32B32A32_SFLOAT;
    this.offset = raw.offset ?? 0;
  }
}

export class VkPipelineInputAssemblyStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.topology = raw.topology ?? VkCoreTopology.TRIANGLE_LIST;
    this.primitiveRestartEnable = false;
  }
}

export class VkPipelineViewportStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.viewportCount = 1;
    this.pViewports = raw.pViewports ?? [new VkViewport(0, 0, 64, 64)];
    this.scissorCount = 1;
    this.pScissors = raw.pScissors ?? [new VkRect2D(0, 0, 64, 64)];
  }
}

export class VkPipelineRasterizationStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.depthClampEnable = false;
    this.rasterizerDiscardEnable = false;
    this.polygonMode = raw.polygonMode ?? VkPolygonMode.FILL;
    this.cullMode = raw.cullMode ?? VkCullModeFlag.BACK;
    this.frontFace = raw.frontFace ?? VkFrontFace.COUNTER_CLOCKWISE;
    this.depthBiasEnable = false;
    this.lineWidth = raw.lineWidth ?? 1.0;
  }
}

export class VkPipelineMultisampleStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.rasterizationSamples = 1;
    this.sampleShadingEnable = false;
  }
}

export class VkPipelineDepthStencilStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.depthTestEnable = raw.depthTestEnable ?? true;
    this.depthWriteEnable = raw.depthWriteEnable ?? true;
    this.depthCompareOp = raw.depthCompareOp ?? VkCompareOp.LESS;
    this.depthBoundsTestEnable = false;
    this.stencilTestEnable = false;
  }
}

export class VkPipelineColorBlendAttachmentState {
  constructor(raw = {}) {
    this.blendEnable = raw.blendEnable ?? false;
    this.srcColorBlendFactor = raw.srcColorBlendFactor ?? VkBlendFactor.ONE;
    this.dstColorBlendFactor = raw.dstColorBlendFactor ?? VkBlendFactor.ZERO;
    this.colorBlendOp = raw.colorBlendOp ?? VkBlendOp.ADD;
    this.srcAlphaBlendFactor = raw.srcAlphaBlendFactor ?? VkBlendFactor.ONE;
    this.dstAlphaBlendFactor = raw.dstAlphaBlendFactor ?? VkBlendFactor.ZERO;
    this.alphaBlendOp = raw.alphaBlendOp ?? VkBlendOp.ADD;
    this.colorWriteMask = raw.colorWriteMask ?? VkColorComponentFlag.RGBA;
  }
}

export class VkPipelineColorBlendStateCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.logicOpEnable = false;
    this.attachmentCount = 1;
    this.pAttachments = raw.pAttachments ?? [new VkPipelineColorBlendAttachmentState(raw)];
  }
}

/**
 * VkGraphicsPipelineCreateInfo — the big one. Fields mirror the packed
 * record the core reads (see wvk_create_graphics_pipeline in core.mjs);
 * vkCreateGraphicsPipeline flattens this object into linear memory.
 */
export class VkGraphicsPipelineCreateInfo {
  constructor(raw = {}) {
    this.flags = 0;
    this.stageCount = 2;
    this.pStages = raw.pStages ?? [
      new VkPipelineShaderStageCreateInfo({
        stage: VkShaderStageFlag.VERTEX, module: raw.vertexShader ?? 0,
      }),
      new VkPipelineShaderStageCreateInfo({
        stage: VkShaderStageFlag.FRAGMENT, module: raw.fragmentShader ?? 0,
      }),
    ];
    this.pVertexInputState = raw.pVertexInputState ?? {
      bindingDescriptions: [new VkVertexInputBindingDescription()],
      attributeDescriptions: raw.attributeDescriptions ?? [],
    };
    this.pInputAssemblyState = new VkPipelineInputAssemblyStateCreateInfo(raw);
    this.pViewportState = new VkPipelineViewportStateCreateInfo(raw);
    this.pRasterizationState = new VkPipelineRasterizationStateCreateInfo(raw);
    this.pMultisampleState = new VkPipelineMultisampleStateCreateInfo(raw);
    this.pDepthStencilState = new VkPipelineDepthStencilStateCreateInfo(raw);
    this.pColorBlendState = new VkPipelineColorBlendStateCreateInfo(raw);
    this.layout = raw.layout ?? VK_NULL_HANDLE;
    this.renderPass = raw.renderPass ?? VK_NULL_HANDLE;
    this.subpass = 0;

    // core extensions (packed-record fields with no direct Vulkan twin)
    this.vertexShader = raw.vertexShader ?? 0;
    this.fragmentShader = raw.fragmentShader ?? 0;
    this.positionLocation = raw.positionLocation ?? 0;
    this.colorLocation = raw.colorLocation ?? 1;
  }
}

export class VkCommandPoolCreateInfo {
  constructor(raw = {}) {
    this.flags = raw.flags ?? 0;
    this.queueFamilyIndex = raw.queueFamilyIndex ?? 0;
    this.resetMode = raw.resetMode ?? 0; // core: 0 = implicit per-record reset
  }
}

export class VkCommandBufferAllocateInfo {
  constructor(raw = {}) {
    this.commandPool = raw.commandPool ?? VK_NULL_HANDLE;
    this.level = raw.level ?? VkCommandBufferLevel.PRIMARY;
    this.commandBufferCount = raw.commandBufferCount ?? 1;
  }
}

export class VkCommandBufferBeginInfo {
  constructor(raw = {}) {
    this.flags = raw.flags ?? 0;
    this.pInheritanceInfo = null;
  }
}

export class VkRenderPassBeginInfo {
  constructor(raw = {}) {
    this.renderPass = raw.renderPass ?? VK_NULL_HANDLE;
    this.framebuffer = raw.framebuffer ?? VK_NULL_HANDLE;
    this.clearValueCount = 1;
    this.pClearValues = raw.pClearValues ?? [new VkClearColorValue()];
    this.renderArea = raw.renderArea ?? new VkRect2D(0, 0, 0, 0);
  }
}

export class VkSubmitInfo {
  constructor(raw = {}) {
    this.waitSemaphoreCount = 0;
    this.pWaitSemaphores = [];
    this.pWaitDstStageMask = [];
    this.commandBufferCount = 1;
    this.pCommandBuffers = raw.pCommandBuffers ?? [];
    this.signalSemaphoreCount = 0;
    this.pSignalSemaphores = [];
  }
}

export class VkFenceCreateInfo {
  constructor(raw = {}) { this.flags = raw.flags ?? 0; }
}

export class VkSemaphoreCreateInfo {
  constructor(raw = {}) { this.flags = raw.flags ?? 0; }
}

/* ================================================================ loader */

const defaultLog = (v) => {
  if (typeof console !== 'undefined') console.log(`[wvk] ${v}`);
};

/**
 * The dispatch context: one loaded wasm instance + Mem + the vk* surface.
 *
 *   const wv = await WebVk.load('/dist/webvk.wasm');
 *   const instance = wv.vkCreateInstance();
 *   const device = wv.vkCreateDevice(instance);
 *   …
 */
export class WebVk {
  /**
   * Fetch + instantiate the core.
   * @param {string|URL|Request|Response|BufferSource} source URL string
   *   (browser fetch), a Response, or raw wasm bytes (node/tests).
   * @param {{log?: (v:number)=>void}} [opts]
   */
  static async load(source = 'dist/webvk.wasm', opts = {}) {
    const log = opts.log ?? defaultLog;
    let bytes;
    if (typeof source === 'string' || source instanceof URL) {
      const res = await fetch(String(source));
      if (!res.ok) throw new Error(`fetch ${source}: HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    } else if (typeof Response !== 'undefined' && source instanceof Response) {
      bytes = await source.arrayBuffer();
    } else {
      bytes = source; // Uint8Array / ArrayBuffer / Node Buffer
    }
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { log },
    });
    return new WebVk(instance);
  }

  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    this.instance = instance;
    /** raw wasm exports — the wvk_* surface, for power users */
    this.E = instance.exports;
    /** JS window onto linear memory (Vk* structs, pixels, staging) */
    this.mem = new Mem(this.E.memory);

    const rc = this.E.wvk_init();
    if (rc !== 0) throw new Error(`wvk_init failed: ${rc}`);

    this._device = VK_NULL_HANDLE;
    this._staging = { handle: VK_NULL_HANDLE, ptr: 0, size: 0 };
    this._viewport = null;
  }

  /* ------------------------------------------------------- statistics */

  /** raw stat read — see VkStat for keys */
  vkGetStat(key) { return this.E.wvk_stat(key | 0); }

  /** all stats as one object (cheap: 10 wasm calls) */
  vkGetStats() {
    const out = {};
    for (const [name, key] of Object.entries(VkStat)) out[name] = this.E.wvk_stat(key);
    return out;
  }

  vkResetStats() { return this.E.wvk_reset_stats(); }

  /** poke the host log hook (demonstrates the wasm import binding) */
  vkDebug(v) { return this.E.wvk_debug(v | 0); }

  /* -------------------------------------------------- staging (scratch) */

  /**
   * Per-call scratch inside the host-visible staging allocation: the
   * bump resets every call (uses never nest) and the core copies out
   * before returning, so a single region serves every create-info and
   * out-param array.
   * @returns {number} linear-memory pointer
   */
  _scratch(bytes) {
    if (this._staging.handle === VK_NULL_HANDLE) this._allocStaging(1 << 16);
    if (bytes > this._staging.size) {
      throw new Error(`staging overflow: ${bytes} > ${this._staging.size}`);
    }
    this._staging.top = 0;
    return this._staging.ptr;
  }

  _allocStaging(size) {
    if (this._device === VK_NULL_HANDLE) {
      throw new Error('staging needed before vkCreateDevice — no device to allocate from');
    }
    const handle = this.E.wvk_alloc_memory(this._device, BigInt(size), 1,
      VkMemoryPropertyFlag.HOST_VISIBLE ? 1 : 0);
    if (handle === VK_NULL_HANDLE) throw new Error('staging allocation failed');
    const ptr = this.E.wvk_map_memory(handle, 0);
    if (ptr === 0) throw new Error('staging map failed');
    this._staging = { handle, ptr, size, top: 0 };
  }

  /* ---------------------------------------------------- result helper */

  _ok(rc, what) {
    if (rc < 0) {
      const name = Object.entries(VkResult).find(([, v]) => v === rc)?.[0] ?? rc;
      throw new Error(`${what} failed: VkResult.${name} (${rc})`);
    }
    return rc;
  }

  _handle(raw, what, Cls) {
    if (raw === VK_NULL_HANDLE) throw new Error(`${what} returned VK_NULL_HANDLE`);
    return Cls ? new Cls(raw) : raw;
  }

  /* ================================================= instance / device */

  /**
   * @param {VkInstanceCreateInfo|object} [pCreateInfo]
   * @returns {VkInstance}
   */
  vkCreateInstance(pCreateInfo = {}) {
    const ci = info(VkInstanceCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_instance(ci.pApplicationInfo.apiVersion, ci.flags);
    return this._handle(raw, 'vkCreateInstance', VkInstance);
  }

  vkDestroyInstance(pInstance) {
    if (!pInstance) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_instance(h(pInstance)), 'vkDestroyInstance');
  }

  /**
   * @param {VkInstance} instance
   * @param {VkDeviceCreateInfo|object} [pCreateInfo]
   * @returns {VkDevice}
   */
  vkCreateDevice(instance, pCreateInfo = {}) {
    const ci = info(VkDeviceCreateInfo, pCreateInfo);
    const queueFamilies = ci.queueCreateInfos.length;
    const features = ci.pEnabledFeatures ? 1 : 0;
    const raw = this.E.wvk_create_device(h(instance), queueFamilies, features);
    const dev = this._handle(raw, 'vkCreateDevice', VkDevice);
    this._device = dev.handle; // staging is allocated from here on
    return dev;
  }

  vkDestroyDevice(pDevice) {
    if (!pDevice) return VkResult.SUCCESS;
    if (h(pDevice) === this._device) this._device = VK_NULL_HANDLE;
    return this._ok(this.E.wvk_destroy_device(h(pDevice)), 'vkDestroyDevice');
  }

  /**
   * @returns {VkQueue}
   */
  vkGetDeviceQueue(device, queueFamilyIndex, queueIndex) {
    const raw = this.E.wvk_get_queue(h(device), queueFamilyIndex, queueIndex);
    return this._handle(raw, 'vkGetDeviceQueue', VkQueue);
  }

  /* ===================================================== surface / sc */

  /**
   * WebVk has no platform window — the "surface" is a canvas element id
   * (the rasterizer's output size lives here, presentation happens in
   * the Viewport below).
   * @returns {VkSurfaceKHR}
   */
  vkCreateSurfaceKHR(width, height, format = VkFormat.R8G8B8A8_UNORM,
    colorSpace = 0, canvasId = 0) {
    const raw = this.E.wvk_create_surface(width, height, format, colorSpace, canvasId);
    return this._handle(raw, 'vkCreateSurfaceKHR', VkSurfaceKHR);
  }

  vkDestroySurfaceKHR(pSurface) {
    if (!pSurface) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_surface(h(pSurface)), 'vkDestroySurfaceKHR');
  }

  /**
   * @param {VkSwapchainCreateInfoKHR|object} pCreateInfo
   * @returns {VkSwapchainKHR}
   */
  vkCreateSwapchainKHR(device, pCreateInfo = {}) {
    const ci = info(VkSwapchainCreateInfoKHR, pCreateInfo);
    const raw = this.E.wvk_create_swapchain(
      h(device), h(ci.surface),
      ci.imageExtent.width, ci.imageExtent.height,
      ci.imageFormat, ci.minImageCount,
    );
    return this._handle(raw, 'vkCreateSwapchainKHR', VkSwapchainKHR);
  }

  vkDestroySwapchainKHR(pSwapchain) {
    if (!pSwapchain) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_swapchain(h(pSwapchain)), 'vkDestroySwapchainKHR');
  }

  /** @returns {VkImage[]} */
  vkGetSwapchainImagesKHR(pSwapchain, maxCount = 8) {
    const p = this._scratch(maxCount * 4);
    const n = this.E.wvk_get_swapchain_images(h(pSwapchain), maxCount, p);
    const out = [];
    for (let i = 0; i < n; i++) out.push(new VkImage(this.mem.readU32(p + i * 4)));
    return out;
  }

  /* ======================================================= memory/bufs */

  /**
   * @param {number} size bytes (JS number → i64 across the ABI)
   * @returns {VkDeviceMemory}
   */
  vkAllocateMemory(device, size, allocationSize = {}, memoryTypeIndex = 0) {
    const props = allocationSize.memoryTypeBits ?? 1;
    const hostVisible = Boolean(
      (memoryTypeIndex & VkMemoryPropertyFlag.HOST_VISIBLE) ||
      (allocationSize.hostVisible ?? 1),
    );
    const raw = this.E.wvk_alloc_memory(h(device), BigInt(size), props, hostVisible ? 1 : 0);
    return this._handle(raw, 'vkAllocateMemory', VkDeviceMemory);
  }

  vkFreeMemory(pMemory) {
    if (!pMemory) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_free_memory(h(pMemory)), 'vkFreeMemory');
  }

  /** @returns {number} linear-memory pointer */
  vkMapMemory(pMemory, offset = 0) {
    const ptr = this.E.wvk_map_memory(h(pMemory), offset);
    if (ptr === 0) throw new Error('vkMapMemory failed');
    return ptr;
  }

  vkUnmapMemory(pMemory) {
    return this._ok(this.E.wvk_unmap_memory(h(pMemory)), 'vkUnmapMemory');
  }

  /**
   * @param {number} size bytes
   * @returns {VkBuffer}
   */
  vkCreateBuffer(device, size, usage = VkBufferUsageFlag.VERTEX_BUFFER) {
    const raw = this.E.wvk_create_buffer(h(device), BigInt(size), usage);
    return this._handle(raw, 'vkCreateBuffer', VkBuffer);
  }

  vkDestroyBuffer(pBuffer) {
    if (!pBuffer) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_buffer(h(pBuffer)), 'vkDestroyBuffer');
  }

  vkBindBufferMemory(pBuffer, pMemory, memoryOffset = 0) {
    return this._ok(
      this.E.wvk_bind_buffer_memory(h(pBuffer), h(pMemory), memoryOffset),
      'vkBindBufferMemory',
    );
  }

  /**
   * WebVk extension (no Vulkan twin): the bound host pointer of a
   * buffer, so JS can write vertex data straight into linear memory.
   * @returns {number}
   */
  vkGetBufferHostPtr(pBuffer) {
    const ptr = this.E.wvk_buffer_ptr(h(pBuffer));
    if (ptr === 0) throw new Error('vkGetBufferHostPtr: buffer has no bound memory');
    return ptr;
  }

  /**
   * @returns {VkImage}
   */
  vkCreateImage(device, pCreateInfo = {}) {
    const raw = this.E.wvk_create_image(
      h(device),
      pCreateInfo.extent?.width ?? pCreateInfo.width ?? 0,
      pCreateInfo.extent?.height ?? pCreateInfo.height ?? 0,
      pCreateInfo.format ?? VkFormat.R8G8B8A8_UNORM,
      pCreateInfo.usage ?? VkImageUsageFlag.COLOR_ATTACHMENT,
    );
    return this._handle(raw, 'vkCreateImage', VkImage);
  }

  vkDestroyImage(pImage) {
    if (!pImage) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_image(h(pImage)), 'vkDestroyImage');
  }

  vkBindImageMemory(pImage, pMemory, memoryOffset = 0) {
    return this._ok(
      this.E.wvk_bind_image_memory(h(pImage), h(pMemory), memoryOffset),
      'vkBindImageMemory',
    );
  }

  /** WebVk extension: bound host pointer of an image's texels. */
  vkGetImageHostPtr(pImage) {
    const ptr = this.E.wvk_image_ptr(h(pImage));
    if (ptr === 0) throw new Error('vkGetImageHostPtr: image has no bound memory');
    return ptr;
  }

  /**
   * @param {VkImageViewCreateInfo|object} pCreateInfo
   * @returns {VkImageView}
   */
  vkCreateImageView(device, pCreateInfo = {}) {
    const ci = info(VkImageViewCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_image_view(
      h(device), h(ci.image), ci.format, ci.subresourceRange.aspectMask,
    );
    return this._handle(raw, 'vkCreateImageView', VkImageView);
  }

  vkDestroyImageView(pImageView) {
    if (!pImageView) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_image_view(h(pImageView)), 'vkDestroyImageView');
  }

  /* =============================================== render pass / fb */

  /**
   * @param {VkRenderPassCreateInfo|object} pCreateInfo
   * @returns {VkRenderPass}
   */
  vkCreateRenderPass(device, pCreateInfo = {}) {
    const ci = info(VkRenderPassCreateInfo, pCreateInfo);
    const color = ci.pAttachments[0];
    // the core models one optional depth attachment: find it, if any
    const depthIdx = ci.pAttachments.findIndex(
      (a) => a.format === VkFormat.D16_UNORM ||
             a.format === VkFormat.D32_SFLOAT ||
             a.format === VkFormat.D32_SFLOAT_S8_UINT,
    );
    const depth = depthIdx >= 0 ? ci.pAttachments[depthIdx] : null;
    const finalLayout = color.finalLayout;
    const raw = this.E.wvk_create_render_pass(
      h(device),
      ci.pSubpasses[0].colorAttachmentCount,
      color.format, color.loadOp, color.storeOp,
      depth ? depth.format : 0,
      depth ? depth.loadOp : VkAttachmentLoadOp.DONT_CARE,
      depth ? depth.storeOp : VkAttachmentStoreOp.DONT_CARE,
      finalLayout,
    );
    return this._handle(raw, 'vkCreateRenderPass', VkRenderPass);
  }

  vkDestroyRenderPass(pRenderPass) {
    if (!pRenderPass) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_render_pass(h(pRenderPass)), 'vkDestroyRenderPass');
  }

  /**
   * @param {VkFramebufferCreateInfo|object} pCreateInfo
   * @returns {VkFramebuffer}
   */
  vkCreateFramebuffer(device, pCreateInfo = {}) {
    const ci = info(VkFramebufferCreateInfo, pCreateInfo);
    const colorView = ci.pAttachments[0] ?? VK_NULL_HANDLE;
    const depthView = ci.pAttachments[1] ?? VK_NULL_HANDLE;
    const raw = this.E.wvk_create_framebuffer(
      h(device), h(ci.renderPass), ci.width, ci.height,
      h(colorView), h(depthView),
    );
    return this._handle(raw, 'vkCreateFramebuffer', VkFramebuffer);
  }

  vkDestroyFramebuffer(pFramebuffer) {
    if (!pFramebuffer) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_framebuffer(h(pFramebuffer)), 'vkDestroyFramebuffer');
  }

  /* ============================================ shaders / pipelines */

  /**
   * @param {VkShaderModuleCreateInfo|object} pCreateInfo
   * @returns {VkShaderModule}
   */
  vkCreateShaderModule(device, pCreateInfo = {}) {
    const ci = info(VkShaderModuleCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_shader_module(h(device), ci.stage, ci.builtin, ci.codeSize);
    return this._handle(raw, 'vkCreateShaderModule', VkShaderModule);
  }

  vkDestroyShaderModule(pShaderModule) {
    if (!pShaderModule) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_shader_module(h(pShaderModule)), 'vkDestroyShaderModule');
  }

  /**
   * @param {VkPipelineLayoutCreateInfo|object} pCreateInfo
   * @returns {VkPipelineLayout}
   */
  vkCreatePipelineLayout(device, pCreateInfo = {}) {
    const ci = info(VkPipelineLayoutCreateInfo, pCreateInfo);
    const range = ci.pPushConstantRanges[0];
    const raw = this.E.wvk_create_pipeline_layout(h(device), range.size, range.stageFlags);
    return this._handle(raw, 'vkCreatePipelineLayout', VkPipelineLayout);
  }

  vkDestroyPipelineLayout(pPipelineLayout) {
    if (!pPipelineLayout) return VkResult.SUCCESS;
    return this._ok(
      this.E.wvk_destroy_pipeline_layout(h(pPipelineLayout)), 'vkDestroyPipelineLayout',
    );
  }

  /**
   * Flattens VkGraphicsPipelineCreateInfo into the core's packed record
   * (84 bytes) + the attribute table (16 bytes each) in staging, then
   * calls the wasm entry point.
   *
   * @param {VkGraphicsPipelineCreateInfo|object} pCreateInfo
   * @returns {VkPipeline}
   */
  vkCreateGraphicsPipeline(device, pCreateInfo = {}) {
    const ci = info(VkGraphicsPipelineCreateInfo, pCreateInfo);
    const attrs = ci.pVertexInputState.attributeDescriptions;
    const base = 84;
    const p = this._scratch(base + attrs.length * 16);
    const m = this.mem;

    const bind = ci.pVertexInputState.bindingDescriptions[0];
    const ia = ci.pInputAssemblyState;
    const rs = ci.pRasterizationState;
    const ds = ci.pDepthStencilState;
    const blend = ci.pColorBlendState.pAttachments[0];

    m.write32(p + 0, ia.topology);
    m.write32(p + 4, rs.cullMode);
    m.write32(p + 8, rs.frontFace);
    m.write32(p + 12, rs.polygonMode);
    m.writeF32(p + 16, rs.lineWidth);
    m.write32(p + 20, ds.depthTestEnable ? 1 : 0);
    m.write32(p + 24, ds.depthWriteEnable ? 1 : 0);
    m.write32(p + 28, ds.depthCompareOp);
    m.write32(p + 32, blend.blendEnable ? 1 : 0);
    m.write32(p + 36, blend.srcColorBlendFactor);
    m.write32(p + 40, blend.dstColorBlendFactor);
    m.write32(p + 44, blend.colorBlendOp);
    m.write32(p + 48, blend.colorWriteMask);
    m.write32(p + 52, ci.vertexShader);
    m.write32(p + 56, ci.fragmentShader);
    m.write32(p + 60, h(ci.layout));
    m.write32(p + 64, bind.stride);
    m.write32(p + 68, attrs.length);
    m.write32(p + 72, ci.positionLocation);
    m.write32(p + 76, ci.colorLocation);
    m.write32(p + 80, p + base);

    attrs.forEach((a, i) => {
      const q = p + base + i * 16;
      m.write32(q + 0, a.location);
      m.write32(q + 4, a.format);
      m.write32(q + 8, a.offset);
      m.write32(q + 12, a.binding);
    });

    const raw = this.E.wvk_create_graphics_pipeline(h(device), p);
    return this._handle(raw, 'vkCreateGraphicsPipeline', VkPipeline);
  }

  vkDestroyPipeline(pPipeline) {
    if (!pPipeline) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_pipeline(h(pPipeline)), 'vkDestroyPipeline');
  }

  /* ================================================== command buffers */

  /**
   * @param {VkCommandPoolCreateInfo|object} pCreateInfo
   * @returns {VkCommandPool}
   */
  vkCreateCommandPool(device, pCreateInfo = {}) {
    const ci = info(VkCommandPoolCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_command_pool(h(device), ci.flags, ci.resetMode);
    return this._handle(raw, 'vkCreateCommandPool', VkCommandPool);
  }

  vkDestroyCommandPool(pCommandPool) {
    if (!pCommandPool) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_command_pool(h(pCommandPool)), 'vkDestroyCommandPool');
  }

  /** @returns {VkCommandBuffer[]} */
  vkAllocateCommandBuffers(pCreateInfo = {}) {
    const ai = info(VkCommandBufferAllocateInfo, pCreateInfo);
    const n = ai.commandBufferCount;
    const p = this._scratch(n * 4);
    const got = this.E.wvk_allocate_command_buffers(
      h(ai.commandPool), ai.level, n, p,
    );
    if (got !== n) throw new Error(`vkAllocateCommandBuffers: wanted ${n}, got ${got}`);
    const out = [];
    for (let i = 0; i < n; i++) out.push(new VkCommandBuffer(this.mem.readU32(p + i * 4)));
    return out;
  }

  vkFreeCommandBuffers(pCommandPool, pCommandBuffers) {
    const list = Array.isArray(pCommandBuffers) ? pCommandBuffers : [pCommandBuffers];
    const p = this._scratch(list.length * 4);
    list.forEach((cb, i) => this.mem.write32(p + i * 4, h(cb)));
    return this._ok(
      this.E.wvk_free_command_buffers(h(pCommandPool), list.length, p),
      'vkFreeCommandBuffers',
    );
  }

  vkBeginCommandBuffer(pCommandBuffer, pBeginInfo = {}) {
    const bi = info(VkCommandBufferBeginInfo, pBeginInfo);
    return this._ok(this.E.wvk_begin_command_buffer(h(pCommandBuffer), bi.flags),
      'vkBeginCommandBuffer');
  }

  vkEndCommandBuffer(pCommandBuffer) {
    return this._ok(this.E.wvk_end_command_buffer(h(pCommandBuffer)), 'vkEndCommandBuffer');
  }

  vkResetCommandBuffer(pCommandBuffer, flags = 0) {
    void flags;
    return this._ok(this.E.wvk_reset_command_buffer(h(pCommandBuffer)),
      'vkResetCommandBuffer');
  }

  /* ================================================== command recording */

  /**
   * @param {VkRenderPassBeginInfo|object} pRenderPassBegin
   * @param {number[]} [clearColor] 0..1 RGBA (overrides pClearValues)
   */
  vkCmdBeginRenderPass(pCommandBuffer, pRenderPassBegin = {}, clearColor = null) {
    const bi = info(VkRenderPassBeginInfo, pRenderPassBegin);
    const c = clearColor ?? bi.pClearValues[0].float32 ?? [0, 0, 0, 1];
    return this._ok(
      this.E.wvk_cmd_begin_render_pass(
        h(pCommandBuffer), h(bi.framebuffer), h(bi.renderPass),
        c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1,
      ),
      'vkCmdBeginRenderPass',
    );
  }

  vkCmdEndRenderPass(pCommandBuffer) {
    return this._ok(this.E.wvk_cmd_end_render_pass(h(pCommandBuffer)),
      'vkCmdEndRenderPass');
  }

  vkCmdBindPipeline(pCommandBuffer, pPipeline) {
    return this._ok(this.E.wvk_cmd_bind_pipeline(h(pCommandBuffer), h(pPipeline)),
      'vkCmdBindPipeline');
  }

  vkCmdBindVertexBuffers(pCommandBuffer, pBuffers, firstBinding = 0) {
    const list = Array.isArray(pBuffers) ? pBuffers : [pBuffers];
    void firstBinding;
    // the core models one bound vertex buffer per draw
    return this._ok(
      this.E.wvk_cmd_bind_vertex_buffers(h(pCommandBuffer), h(list[0])),
      'vkCmdBindVertexBuffers',
    );
  }

  /** @param {VkViewport|object} pViewport */
  vkCmdSetViewport(pCommandBuffer, pViewport = {}, firstViewport = 0) {
    void firstViewport;
    const vp = pViewport instanceof VkViewport ? pViewport : info(VkViewport, pViewport);
    return this._ok(
      this.E.wvk_cmd_set_viewport(
        h(pCommandBuffer), vp.x, vp.y, vp.width, vp.height, vp.minDepth, vp.maxDepth,
      ),
      'vkCmdSetViewport',
    );
  }

  /** @param {VkRect2D|object} pScissor */
  vkCmdSetScissor(pCommandBuffer, pScissor = {}, firstScissor = 0) {
    void firstScissor;
    const s = pScissor instanceof VkRect2D ? pScissor : info(VkRect2D, pScissor);
    return this._ok(
      this.E.wvk_cmd_set_scissor(
        h(pCommandBuffer), s.offset.x, s.offset.y, s.extent.width, s.extent.height,
      ),
      'vkCmdSetScissor',
    );
  }

  /**
   * Push constants are copied into the record at call time, so animating
   * per frame means calling this again after a command-buffer reset.
   *
   * @param {ArrayBuffer|ArrayBufferView|number[]} pData raw bytes, a
   *   typed array, or a plain number[] (treated as f32 words — MVP
   *   matrices arrive that way).
   */
  vkCmdPushConstants(pCommandBuffer, pLayout, stageFlags, pData, size = null) {
    let bytes;
    if (Array.isArray(pData)) {
      const f = new Float32Array(pData);
      bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    } else if (ArrayBuffer.isView(pData)) {
      bytes = new Uint8Array(pData.buffer, pData.byteOffset, pData.byteLength);
    } else {
      bytes = new Uint8Array(pData);
    }
    const want = size ?? bytes.byteLength;
    const p = this._scratch(want);
    this.mem.writeBytes(p, bytes.subarray(0, want));
    return this._ok(
      this.E.wvk_cmd_push_constants(h(pCommandBuffer), h(pLayout), stageFlags, p, want),
      'vkCmdPushConstants',
    );
  }

  vkCmdDraw(pCommandBuffer, vertexCount, firstVertex = 0, instanceCount = 1) {
    return this._ok(
      this.E.wvk_cmd_draw(h(pCommandBuffer), vertexCount, firstVertex, instanceCount),
      'vkCmdDraw',
    );
  }

  /* ========================================================== queue ops */

  /**
   * Replays the command buffer synchronously (see the sync model at the
   * top of this file), then signals the fence.
   *
   * @param {VkSubmitInfo|object} pSubmits
   */
  vkQueueSubmit(pQueue, pSubmits = {}, pFence = null) {
    const si = info(VkSubmitInfo, pSubmits);
    const cbs = Array.isArray(si.pCommandBuffers) ? si.pCommandBuffers : [si.pCommandBuffers];
    let rc = 0;
    for (const cb of cbs) {
      rc = this.E.wvk_queue_submit(h(pQueue), h(cb), h(pFence ?? 0));
      this._ok(rc, 'vkQueueSubmit');
    }
    return rc;
  }

  vkQueuePresentKHR(pQueue, pSwapchain) {
    return this._ok(
      this.E.wvk_queue_present(h(pQueue), h(pSwapchain)), 'vkQueuePresentKHR',
    );
  }

  /**
   * WebVk extension: which swapchain image is current. Useful when a
   * framebuffer exists per image (as it must, for double buffering):
   * present flips the index, so the next frame must bind a different FB.
   * @param {VkSwapchainKHR|number} pSwapchain
   * @param {Array<VkImage|number>} images
   * @returns {number} -1 if the current pointer matches no image
   */
  vkGetSwapchainImageIndex(pSwapchain, images) {
    const ptr = this.E.wvk_frame_ptr(h(pSwapchain));
    for (let i = 0; i < images.length; i++) {
      if (this.E.wvk_image_ptr(h(images[i])) === ptr) return i;
    }
    return -1;
  }

  /**
   * WebVk extension: linear-memory pointer of the swapchain's current
   * image — what the Viewport blits each frame.
   * @returns {number}
   */
  vkGetSwapchainFramePtr(pSwapchain) {
    const ptr = this.E.wvk_frame_ptr(h(pSwapchain));
    if (ptr === 0) throw new Error('vkGetSwapchainFramePtr failed');
    return ptr;
  }

  /* ================================================= sync primitives */

  /** @returns {VkFence} */
  vkCreateFence(device, pCreateInfo = {}) {
    const ci = info(VkFenceCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_fence(h(device), ci.flags);
    return this._handle(raw, 'vkCreateFence', VkFence);
  }

  vkDestroyFence(pFence) {
    if (!pFence) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_fence(h(pFence)), 'vkDestroyFence');
  }

  /** @returns {VkSemaphore} */
  vkCreateSemaphore(device, pCreateInfo = {}) {
    const ci = info(VkSemaphoreCreateInfo, pCreateInfo);
    const raw = this.E.wvk_create_semaphore(h(device), ci.flags);
    return this._handle(raw, 'vkCreateSemaphore', VkSemaphore);
  }

  vkDestroySemaphore(pSemaphore) {
    if (!pSemaphore) return VkResult.SUCCESS;
    return this._ok(this.E.wvk_destroy_semaphore(h(pSemaphore)), 'vkDestroySemaphore');
  }

  /* ========================================================= viewport */

  /**
   * Presentation lives entirely on the JS side (per the WebVk design):
   * the wasm-gc rasterizer writes RGBA8 into linear memory → we blit it
   * into a <canvas> → canvas.captureStream() → a loopback
   * RTCPeerConnection → a <video> element. The core never sees a canvas.
   *
   * @param {{canvas?: HTMLCanvasElement, video?: HTMLVideoElement,
   *          width?: number, height?: number, fps?: number,
   *          parent?: Element, useWebRTC?: boolean}} [opts]
   * @returns {Viewport}
   */
  createViewport(opts = {}) {
    this._viewport = new Viewport(this, opts);
    return this._viewport;
  }

  get viewport() { return this._viewport; }

  /** tear down the last viewport created through this context */
  vkDestroyViewport() {
    if (this._viewport) this._viewport.destroy();
    this._viewport = null;
    return VkResult.SUCCESS;
  }
}

/* ============================================================= viewport */

/**
 * WebVk's swapchain presentation, as chosen for this project:
 *
 *     linear memory (RGBA8)  --blit-->  <canvas>  --captureStream()-->
 *         RTCPeerConnection (loopback, no signaling server)-->
 *         <video> element
 *
 * The blit is a straight byte copy: the core packs pixels little-endian
 * R,G,B,A — exactly ImageData's layout — so no swizzle is needed.
 *
 * `useWebRTC: false` skips the peer-connection dance and leaves the
 * canvas as the presentation target (handy in node / headless tests).
 *
 * Turbo mode (`turbo: true`, the default) captures at 0 fps and calls
 * `requestFrame()` right after every blit: frames are delivered only
 * when a rendered image exists. Rate-based captureStream(fps) can
 * otherwise emit frames while the swapchain index points at an
 * unrendered image — the classic WebVk "blink".
 */
export class Viewport {
  /**
   * @param {WebVk} wv
   * @param {object} [opts]
   */
  constructor(wv, opts = {}) {
    this.wv = wv;
    this.width = opts.width ?? 0;
    this.height = opts.height ?? 0;
    this.fps = opts.fps ?? 60;
    this.useWebRTC = opts.useWebRTC !== false;
    this.turbo = opts.turbo ?? true; // deterministic frame delivery
    this._captureTrack = null;

    this.canvas = opts.canvas ?? null;
    if (!this.canvas && typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      (opts.parent ?? document.body).appendChild(this.canvas);
    }
    if (this.canvas) {
      this.canvas.width = this.width || this.canvas.width || 64;
      this.canvas.height = this.height || this.canvas.height || 64;
      this.width = this.canvas.width;
      this.height = this.canvas.height;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
      // a detached canvas still works for captureStream, but keep it in
      // the document when one exists so browsers keep compositing it
      if (!this.canvas.isConnected && typeof document !== 'undefined') {
        opts.parent?.appendChild(this.canvas);
      }
    }

    this.video = opts.video ?? null;
    this.stream = null;
    this.pc1 = null;
    this.pc2 = null;
    this._imageData = null;
    this._started = false;
  }

  /** size the rasterizer should use for this presentation target */
  resize(width, height) {
    this.width = width;
    this.height = height;
    if (this.canvas) { this.canvas.width = width; this.canvas.height = height; }
    this._imageData = null;
  }

  /** the capture source: turbo pushes frames explicitly, normal uses fps */
  _openStream() {
    if (!this.canvas || typeof this.canvas.captureStream !== 'function') return null;
    return this.canvas.captureStream(this.turbo ? 0 : this.fps);
  }

  /**
   * Toggle turbo mode at runtime. Swaps the canvas track on the existing
   * sender with replaceTrack() — no renegotiation, no visible glitch — so
   * a UI toggle can flip it between frames.
   * @returns {Promise<Viewport>}
   */
  async setTurbo(on) {
    if (this.turbo === !!on) return this;
    this.turbo = !!on;
    if (!this._started || !this.stream) return this;

    const old = this.stream;
    const next = this._openStream();
    const track = next?.getVideoTracks()[0] ?? null;
    const sender = this.pc1?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender && track) await sender.replaceTrack(track);
    this.stream = next;
    this._captureTrack = this.turbo ? track : null;
    for (const t of old.getTracks()) t.stop();
    return this;
  }

  /**
   * Kick off presentation. With WebRTC enabled this negotiates a
   * loopback connection (pc1 → pc2 in-page, no signaling server) and
   * parks the remote stream on <video>; `video.play()` is called once
   * the remote track arrives.
   *
   * @returns {Promise<Viewport>} resolves when the video track is live
   *   (or immediately when useWebRTC is false)
   */
  async start() {
    if (this._started) return this;
    this._started = true;

    if (!this.useWebRTC || typeof RTCPeerConnection === 'undefined' || !this.canvas) {
      return this; // canvas-only presentation
    }

    this.stream = this._openStream();

    // classic in-page loopback: two peers wired to each other, the
    // offer/answer exchanged directly (no server involved)
    const cfg = { iceServers: [] };
    this.pc1 = new RTCPeerConnection(cfg);
    this.pc2 = new RTCPeerConnection(cfg);
    this.pc1.onicecandidate = (e) => e.candidate && this.pc2.addIceCandidate(e.candidate);
    this.pc2.onicecandidate = (e) => e.candidate && this.pc1.addIceCandidate(e.candidate);

    for (const track of this.stream.getTracks()) this.pc1.addTrack(track, this.stream);

    const remote = new MediaStream();
    const trackReady = new Promise((resolve) => {
      this.pc2.ontrack = (e) => {
        remote.addTrack(e.track);
        resolve();
      };
    });

    const offer = await this.pc1.createOffer();
    await this.pc1.setLocalDescription(offer);
    await this.pc2.setRemoteDescription(offer);
    const answer = await this.pc2.createAnswer();
    await this.pc2.setLocalDescription(answer);
    await this.pc1.setRemoteDescription(answer);

    await trackReady;
    this._captureTrack = this.turbo ? this.stream.getVideoTracks()[0] : null;
    if (!this.video && typeof document !== 'undefined') {
      this.video = document.createElement('video');
      this.video.autoplay = true;
      this.video.playsInline = true;
      (this.canvas.parentElement ?? document.body).appendChild(this.video);
    }
    if (this.video) {
      this.video.srcObject = remote;
      // Fire-and-forget: awaiting play() deadlocks here — the browser
      // waits for media frames, captureStream only produces them once
      // the render loop blits, and that loop is waiting on start().
      this.video.play().catch(() => { /* autoplay policy — user gesture */ });
    }
    return this;
  }

  /**
   * Copy the swapchain's current image (RGBA8 in linear memory) into
   * the canvas. One ImageData is reused; a memory.grow between frames
   * detaches the old view, so the backing array is re-fetched when the
   * buffer identity changes.
   *
   * @param {VkSwapchainKHR|number} pSwapchain
   */
  blit(pSwapchain) {
    if (!this.canvas || !this.ctx) return;
    const ptr = this.wv.vkGetSwapchainFramePtr(pSwapchain);
    const w = this.width;
    const hgt = this.height;
    if (!w || !hgt) return;

    const buf = this.wv.mem.mem.buffer;
    const need = w * hgt * 4;
    // browsers give us ImageData; headless (node tests) gets a plain
    // {width, height, data} record that putImageData implementations
    // without the constructor can still accept
    const mk = (view) => (typeof ImageData !== 'undefined'
      ? new ImageData(view, w, hgt)
      : { width: w, height: hgt, data: view });
    if (!this._imageData || this._imageData.data.buffer !== buf ||
        this._imageData.width !== w || this._imageData.height !== hgt) {
      this._imageData = mk(new Uint8ClampedArray(buf, ptr, need));
    } else {
      // same memory: refresh the view (ptr may move with swapchain index)
      const view = new Uint8ClampedArray(buf, ptr, need);
      if (this._imageData.data !== view) this._imageData.data.set(view);
    }
    this.ctx.putImageData(this._imageData, 0, 0);
    // Turbo: deliver exactly this frame, immediately after the blit.
    // No timer-driven capture of a stale swapchain image → no blinking.
    if (this._captureTrack?.requestFrame) this._captureTrack.requestFrame();
  }

  /**
   * The whole presentation step: blit the just-submitted frame, then
   * flip the swapchain index (what vkQueuePresentKHR does).
   *
   * @param {VkQueue|number} pQueue
   * @param {VkSwapchainKHR|number} pSwapchain
   */
  present(pQueue, pSwapchain) {
    this.blit(pSwapchain);
    return this.wv.vkQueuePresentKHR(pQueue, pSwapchain);
  }

  /** stop streaming and close the loopback connection */
  destroy() {
    if (this.pc1) this.pc1.close();
    if (this.pc2) this.pc2.close();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.pc1 = this.pc2 = this.stream = null;
    this._captureTrack = null;
    this._started = false;
  }
}

export default WebVk;
