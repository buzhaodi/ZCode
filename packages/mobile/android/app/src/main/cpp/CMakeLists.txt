cmake_minimum_required(VERSION 3.4.1)

add_library(zcode-node-mobile SHARED native-lib.cpp)

# Node.js headers
include_directories(${CMAKE_SOURCE_DIR}/include/node/)

# Import pre-built libnode.so
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(zcode-node-mobile libnode ${log-lib})

# Android 15+ 要求 native 库 16KB 页对齐
target_link_options(zcode-node-mobile PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)
