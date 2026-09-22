/* Android-compatible JNI platform definitions.
 * Defines the basic JNI types and export macros for the Android (Linux) platform. */
#ifndef JNI_MD_H
#define JNI_MD_H

#define JNIEXPORT __attribute__((visibility("default")))
#define JNIIMPORT __attribute__((visibility("default")))
#define JNICALL

/* JNI basic types — same as Linux JDK */
typedef signed char jbyte;
typedef short jshort;
typedef int jint;
typedef long long jlong;
typedef unsigned char jboolean;
typedef unsigned short jchar;
typedef float jfloat;
typedef double jdouble;

/* jint sized types */
typedef jint jsize;

#endif /* JNI_MD_H */
