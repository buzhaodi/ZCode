/*
 * ZCode Android JNI bridge — 在 Android 进程内启动 Node.js (nodejs-mobile)。
 *
 * 简化版：仅提供 startNodeWithArguments，不需要消息通道。
 * 端口通信通过文件：Node.js 脚本将端口写入 port.txt，Java 侧轮询读取。
 * stdout/stderr 重定向到 Android logcat 以便调试。
 */
#include <jni.h>
#include <string>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "ZCODE-NODE"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static pthread_t node_thread;
static bool node_started = false;

struct NodeArgs {
    int argc;
    char** argv;
};

extern "C" int callintoNode(int argc, char *argv[]) {
    return node::Start(argc, argv);
}

static int start_redirecting_stdout_stderr() {
    /* 将 Node.js 的 stdout/stderr 重定向到 Android logcat */
    int pipes[2];
    if (pipe(pipes) != 0) return -1;

    /* stdout → pipe write end */
    dup2(pipes[1], STDOUT_FILENO);
    dup2(pipes[1], STDERR_FILENO);

    /* 在新线程中读取 pipe 并写入 logcat */
    pthread_t log_thread;
    pthread_create(&log_thread, NULL, [](void* arg) -> void* {
        int fd = *(int*)arg;
        char buf[1024];
        ssize_t n;
        while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
            buf[n] = '\0';
            __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "%s", buf);
        }
        return NULL;
    }, &pipes[0]);
    pthread_detach(log_thread);

    return 0;
}

static void* node_thread_func(void* arg) {
    NodeArgs* nodeArgs = (NodeArgs*)arg;

    start_redirecting_stdout_stderr();

    LOGI("Starting Node.js with %d arguments", nodeArgs->argc);
    for (int i = 0; i < nodeArgs->argc; i++) {
        LOGI("  argv[%d] = %s", i, nodeArgs->argv[i]);
    }

    int exit_code = callintoNode(nodeArgs->argc, nodeArgs->argv);
    LOGI("Node.js exited with code %d", exit_code);

    /* 释放参数 */
    for (int i = 0; i < nodeArgs->argc; i++) {
        free(nodeArgs->argv[i]);
    }
    free(nodeArgs->argv);
    free(nodeArgs);

    return NULL;
}

extern "C"
JNIEXPORT jboolean JNICALL
Java_com_zcode_mobile_NodeMobile_startNodeWithArguments(
    JNIEnv *env,
    jobject /* this */,
    jobjectArray arguments,
    jstring nodePath) {

    if (node_started) {
        LOGE("Node.js already started");
        return JNI_FALSE;
    }
    node_started = true;

    /* 设置 NODE_PATH 环境变量 */
    const char* path = env->GetStringUTFChars(nodePath, 0);
    setenv("NODE_PATH", path, 1);
    LOGI("NODE_PATH set to: %s", path);
    env->ReleaseStringUTFChars(nodePath, path);

    /* 转换 Java 参数数组为 C argv */
    int argc = env->GetArrayLength(arguments);
    NodeArgs* nodeArgs = (NodeArgs*)malloc(sizeof(NodeArgs));
    nodeArgs->argc = argc;
    nodeArgs->argv = (char**)malloc((argc + 1) * sizeof(char*));

    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring)env->GetObjectArrayElement(arguments, i);
        const char* str = env->GetStringUTFChars(arg, 0);
        nodeArgs->argv[i] = strdup(str);
        env->ReleaseStringUTFChars(arg, str);
        env->DeleteLocalRef(arg);
    }
    nodeArgs->argv[argc] = NULL;

    /* 在新线程中启动 Node.js（不阻塞 JNI 调用） */
    int result = pthread_create(&node_thread, NULL, node_thread_func, nodeArgs);
    if (result != 0) {
        LOGE("Failed to create Node.js thread");
        return JNI_FALSE;
    }
    pthread_detach(node_thread);

    LOGI("Node.js thread started");
    return JNI_TRUE;
}

#if defined(__arm__)
    #define CURRENT_ABI_NAME "armeabi-v7a"
#elif defined(__aarch64__)
    #define CURRENT_ABI_NAME "arm64-v8a"
#elif defined(__i386__)
    #define CURRENT_ABI_NAME "x86"
#elif defined(__x86_64__)
    #define CURRENT_ABI_NAME "x86_64"
#else
    #error "Unknown ABI"
#endif

extern "C"
JNIEXPORT jstring JNICALL
Java_com_zcode_mobile_NodeMobile_getCurrentABIName(
    JNIEnv *env,
    jobject /* this */) {
    return env->NewStringUTF(CURRENT_ABI_NAME);
}
