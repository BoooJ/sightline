# Plugin TeamSpeak 3 « Sightline Comms » : une piste Opus par voix, débuts de rounds lus par la GSI de CS2.
# Construire en 32 et 64 bits (le client de l'user est en 32 bits) : pwsh plugin/build.ps1
cmake_minimum_required(VERSION 3.20)
project(sightline_comms VERSION 1.0.0 LANGUAGES C CXX RC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# CRT statique : la DLL ne dépend d'aucun redistribuable Visual C++ sur le PC de l'enregistreur
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# libopus en bibliothèque statique, sans ses tests ni ses programmes
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/opus EXCLUDE_FROM_ALL)

# Nos sources (pas celles d'opus, ajoutées avant) : UTF-8, avertissements ; rien de tout ça pour rc.exe
add_compile_options("$<$<COMPILE_LANGUAGE:C,CXX>:/utf-8;/W3>")
add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)

# Cœur : sans TeamSpeak ni interface Windows, testé par CTest
file(GLOB CORE_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/core/*.cpp)
add_library(sightline_core STATIC ${CORE_SOURCES})
target_include_directories(sightline_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(sightline_core PUBLIC opus)

enable_testing()
file(GLOB CORE_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/core/*.cpp)
add_executable(sightline_core_tests tests/check_main.cpp ${CORE_TESTS})
target_include_directories(sightline_core_tests PRIVATE tests)
target_link_libraries(sightline_core_tests PRIVATE sightline_core)
add_test(NAME core COMMAND sightline_core_tests)

# Couche Windows : horloge précise, DPAPI, WinHTTP, écoute GSI (Winsock), registre Steam
file(GLOB WIN_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/win/*.cpp)
add_library(sightline_win STATIC ${WIN_SOURCES})
target_link_libraries(sightline_win PUBLIC sightline_core winhttp ws2_32 crypt32 advapi32)

add_executable(sightline_win_tests tests/check_main.cpp tests/win/test_win.cpp)
target_include_directories(sightline_win_tests PRIVATE tests)
target_link_libraries(sightline_win_tests PRIVATE sightline_win)
add_test(NAME win COMMAND sightline_win_tests)

# Harnais de bout en bout sans TeamSpeak (envoi : tests/e2e_upload.py)
add_executable(sightline_fake_session tests/fake_session.cpp)
target_include_directories(sightline_fake_session PRIVATE tests)
target_link_libraries(sightline_fake_session PRIVATE sightline_win)
add_test(NAME fake_session COMMAND sightline_fake_session ${CMAKE_CURRENT_BINARY_DIR}/fake-session-test)

# Dialogue des réglages et son aperçu sans TeamSpeak (CTest : ouverture puis fermeture automatique)
add_executable(sightline_settings_preview WIN32 tests/settings_preview.cpp ts3/settings_dialog.cpp ts3/settings.rc)
target_link_libraries(sightline_settings_preview PRIVATE sightline_win user32)
add_test(NAME settings_dialog COMMAND sightline_settings_preview --auto-close)

# La DLL TeamSpeak : sightline_comms_win32.dll ou sightline_comms_win64.dll (les deux vont dans le paquet)
set(TS3SDK ${CMAKE_CURRENT_SOURCE_DIR}/third_party/ts3sdk)
add_library(sightline_comms SHARED ts3/app.cpp ts3/plugin.cpp ts3/settings_dialog.cpp ts3/settings.rc)
target_include_directories(sightline_comms PRIVATE ${TS3SDK}/include ${TS3SDK}/src)
target_link_libraries(sightline_comms PRIVATE sightline_win user32)
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set_target_properties(sightline_comms PROPERTIES OUTPUT_NAME sightline_comms_win64)
else()
  set_target_properties(sightline_comms PROPERTIES OUTPUT_NAME sightline_comms_win32)
endif()

# Chargement de la DLL comme le ferait TeamSpeak (fausse table TS3Functions), map simulée
add_executable(sightline_dll_smoke tests/dll_smoke.cpp)
target_include_directories(sightline_dll_smoke PRIVATE tests ${TS3SDK}/include)
target_link_libraries(sightline_dll_smoke PRIVATE sightline_core ws2_32)
add_dependencies(sightline_dll_smoke sightline_comms)
add_test(NAME dll_smoke COMMAND sightline_dll_smoke $<TARGET_FILE:sightline_comms>)
