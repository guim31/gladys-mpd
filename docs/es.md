# Music Player Daemon

Controle sus reproductores [MPD](https://www.musicpd.org) desde Gladys: una
Raspberry Pi conectada a un amplificador con moOde, Volumio, piCorePlayer o el
propio MPD. Reproducir, pausar, cambiar de canción y de volumen, lanzar una
lista de reproducción, reproducir un timbre o una radio web y después volver a
la música, y ver en el panel lo que suena. Todo se queda en su red local: sin
nube, sin cuenta.

> **Desarrollada sin el hardware: sus comentarios son bienvenidos.** La
> integración se construyó y probó con un servidor MPD simulado que responde
> como MPD 0.23, no con un reproductor real. Indique lo que funciona y lo que
> no en las [issues](https://github.com/guim31/gladys-mpd/issues).

Esta integración no está afiliada al proyecto MPD, ni a moOde, Volumio o
piCorePlayer.

## Lo que necesita

- Gladys Assistant **5.2.0** o posterior.
- Un reproductor con **MPD**, accesible desde Gladys en la red, en su puerto
  MPD (**6600** por defecto). moOde y piCorePlayer (con su extensión MPD) lo
  exponen de serie; el propio MPD escucha en la red cuando `bind_to_address`
  vale `any` o la IP de la máquina en `mpd.conf`.
- La contraseña de MPD si `mpd.conf` tiene una línea `password`. Necesita los
  permisos `read`, `add` y `control` (`password "secret@read,add,control"`).
  La mayoría de los reproductores no tienen.

## Puesta en marcha

1. En Gladys, abra **Integraciones**, luego **Instalar desde GitHub**, e
   introduzca `https://github.com/guim31/gladys-mpd` (o instale **Music Player
   Daemon** desde el catálogo cuando aparezca).
2. En **Configuración**, introduzca la dirección de su reproductor
   (`192.168.1.20`, `moode.home`, o `192.168.1.20:6601` para otro puerto), su
   contraseña si la tiene y un nombre (`Salón`). Hasta tres reproductores más
   debajo.
3. Elija el **Idioma de los dispositivos** (nombres de las funciones,
   mensajes) y, si lo desea, el **Volumen de las notificaciones**. Guarde.
4. Pulse **Probar la conexión**: una línea por reproductor, con la versión de
   MPD, lo que está haciendo, su volumen y sus listas de reproducción.
5. Abra la pestaña **Descubrir** y añada los dispositivos.

Use direcciones IP fijas (una reserva DHCP en su router) o nombres que su DNS
resuelva: los nombres que terminan en `.local` no se resuelven dentro del
contenedor de la integración.

## El dispositivo de cada reproductor

Cada reproductor es un dispositivo. Gladys lo muestra como un reproductor de
música: la caja **Música** del panel (reproducir, pausa, anterior, siguiente,
volumen) y la acción de escena **Hablar en un altavoz** funcionan con él.

| Función (nombres en español) | Lo que hace                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Reproducir                   | Reproduce la cola (una canción en pausa sigue donde estaba).                                                        |
| Pausa                        | Pone en pausa.                                                                                                      |
| Pista anterior               | Pasa a la canción anterior.                                                                                         |
| Pista siguiente              | Pasa a la canción siguiente.                                                                                        |
| Volumen                      | 0 a 100 %, tal como lo ve MPD. Sin valor cuando MPD no tiene mezclador (volumen fijo).                              |
| Estado de reproducción       | 1 durante la reproducción, 0 en pausa o detenido. Guardado en el historial, utilizable como disparador o condición. |
| Lista de reproducción        | La lista de las listas guardadas en MPD: elegir una sustituye la cola por ella y la reproduce.                      |
| Notificación                 | Recibe una dirección que reproducir y luego vuelve a lo que sonaba (ver más abajo).                                 |

La lista sigue a MPD: una lista guardada o borrada en el reproductor aparece o
desaparece de la lista.

## Widget del panel

Añada el widget **Reproductor MPD** a un panel. En sus ajustes, elija un
reproductor (vacío: el primero de la configuración). Muestra:

- el **título** de la canción y, debajo, el artista y el álbum (o el nombre de
  la radio web);
- el **volumen** como indicador;
- el estado (reproduciendo, en pausa, detenido), la posición en la cola, el
  modo aleatorio y la repetición;
- cuatro botones: **Anterior**, **Reproducir** o **Pausa**, **Siguiente** y
  **Opciones…**. Opciones… abre un formulario con los valores actuales: el
  volumen, una lista que reproducir, el modo aleatorio y la repetición. Solo
  se envía lo que usted cambia.

El widget sigue al reproductor: se actualiza en menos de diez segundos cuando
empieza una canción, cambia el volumen o se guarda una lista. Sin carátula
(ver Límites).

## Escenas

### Acciones

El reproductor se elige entre los dispositivos de la integración.

- **Reproducir una lista de MPD**: sustituye la cola por una lista guardada en
  MPD, según su nombre (mayúsculas y acentos indiferentes), y la reproduce. El
  número de canciones en cola puede usarse en las acciones siguientes de la
  escena. Un nombre desconocido hace fallar la acción con la lista de las
  listas. También puede elegir una lista en un desplegable con la acción
  **Controlar un dispositivo** del núcleo, en la función **Lista de
  reproducción**.
- **Reproducir una dirección en MPD**: reproduce una dirección — una radio web
  (`http://…`, `https://…`), un sonido en un servidor web o un archivo de la
  biblioteca musical de MPD (`sonidos/timbre.mp3`) — al volumen indicado
  (vacío: sin cambios). _Después_: **Volver a la música anterior** (la
  dirección suena una vez y luego vuelve lo que sonaba, ver más abajo) o
  **Seguir (sustituye la cola)**. La acción falla cuando MPD no puede
  reproducir la dirección.
- **Vaciar la cola de MPD**: quita todas las canciones de la cola; el
  reproductor se detiene.
- **Reproducción aleatoria MPD**: activar, desactivar o invertir. El resultado
  (activa o no) puede usarse en las acciones siguientes.
- **Repetición MPD**: desactivada, toda la cola o la canción actual.

### Notificaciones y «Hablar en un altavoz»

La función **Notificación** de un reproductor, la acción **Reproducir una
dirección en MPD** con _Volver a la música anterior_ y la acción **Hablar en un
altavoz** de Gladys (la voz viene de Gladys Plus) funcionan igual:

1. la dirección se añade al final de la cola (su cola nunca se sustituye) y se
   reproduce enseguida, con el **Volumen de las notificaciones** de la
   configuración (o el volumen de la acción);
2. MPD se detiene después; entonces se quita de la cola, y el volumen y las
   opciones (aleatorio, repetición, single, consume) vuelven;
3. la canción que sonaba sigue en el segundo en que se interrumpió; una
   canción en pausa sigue en pausa, un reproductor detenido sigue detenido.

Una segunda notificación durante la primera la sustituye. Si alguien toma el
control del reproductor mientras tanto (otra canción, la siguiente), la
notificación termina sin tocar la música. Una notificación que sigue sonando a
los cinco minutos se termina y la música vuelve. Una radio web enviada como
notificación no es una notificación: sigue sonando (su dirección se queda en la
cola).

La acción **Hablar en un altavoz** tiene un control de volumen, pero Gladys no
lo transmite a las integraciones externas: use el **Volumen de las
notificaciones** de la configuración.

### Ideas de escenas

- **Timbre**: cuando se pulsa el botón del timbre, _Reproducir una dirección en
  MPD_ `sonidos/timbre.mp3` en el reproductor del salón, volumen 70, y luego
  volver a la música anterior.
- **Radio despertador**: a las 7:00 entre semana, _Reproducir una dirección en
  MPD_ con la dirección de su radio favorita, _Seguir_, volumen 25; a las
  7:45, la función **Pausa**.
- **Nadie en casa**: cuando la casa se queda vacía, la función **Pausa** de
  cada reproductor.
- **La luz sigue a la música**: cuando el **Estado de reproducción** del
  reproductor del salón pasa a 1 después de la puesta de sol, encender las
  lámparas del salón.
- **Tarde**: a la puesta de sol, _Reproducir una lista de MPD_ «Apéro» y luego
  _Reproducción aleatoria MPD_ activada.

## Actualización

La integración mantiene una conexión abierta con cada reproductor y espera sus
cambios (el comando `idle` de MPD): lo que pasa en el reproductor, desde Gladys
o desde otra aplicación, llega a Gladys en menos de un segundo. Además, cada
reproductor se lee cada 30 segundos (así se comprueba también que sigue
respondiendo), y un valor sin cambios se reenvía cada seis horas para que
Gladys nunca lo muestre como antiguo. Solo se envían a Gladys los cambios.

Un reproductor que deja de responder se muestra inaccesible (indicador de
transporte del dispositivo, estado de conexión de la integración), y la
integración vuelve a intentarlo: tras 2, 5, 15, 30 segundos y luego cada
minuto. No hay nada que hacer cuando vuelve.

MPD no tiene cuota: la integración envía unos pocos comandos por cambio y dos
cada 30 segundos, con una conexión por reproductor.

## Solución de problemas

- **«no responde»**: compruebe la dirección y el puerto (6600, o el de `port`
  en `mpd.conf`), que MPD escucha en la red (`bind_to_address`) y que ningún
  cortafuegos bloquea el puerto entre Gladys y el reproductor.
- **«contraseña rechazada»** o **«se necesita una contraseña»**: introduzca la
  contraseña de la línea `password` de `mpd.conf`; necesita los permisos
  `read`, `add` y `control`.
- **«no hay ningún servidor MPD en esta dirección y puerto»**: otra cosa
  responde en ese puerto (una interfaz web, por ejemplo): MPD escucha en el
  6600 por defecto.
- **El volumen se queda vacío**: MPD no tiene mezclador (`mixer_type "none"`
  en moOde para un DAC de volumen fijo, por ejemplo): cambie el volumen en el
  amplificador.
- **Una notificación no suena**: la dirección debe ser accesible desde el
  propio reproductor (no desde Gladys), en un formato que MPD sepa
  decodificar; un archivo de la biblioteca se indica con su ruta en la
  biblioteca. **Probar la conexión** y los registros de la integración dicen
  por qué MPD la rechazó.
- **La lista de reproducción está vacía**: MPD no tiene `playlist_directory`,
  o todavía no hay ninguna lista guardada.
- **Más detalles**: los registros de la integración (Integraciones → Music
  Player Daemon → Registros) muestran las conexiones, las pérdidas y los
  regresos, y una línea por comando. Reinicie el contenedor con
  `LOG_LEVEL=debug` para ver cada cambio recibido y cada lectura. Las
  contraseñas nunca se escriben.

## Límites

- Hasta cuatro reproductores. Un reproductor se reconoce por su posición en la
  configuración: cambiar su dirección conserva el dispositivo y su historial.
- Sin carátula en el widget: MPD la envía sin reducir, a menudo por encima de
  lo que Gladys acepta.
- Sin navegación por la biblioteca musical: solo listas, direcciones y rutas de
  la biblioteca.
- Sin agrupación de reproductores (Snapcast) ni elección de salidas.
- MPD no se descubre solo en la red: introduzca las direcciones.
- Gladys no transmite el volumen de la acción **Hablar en un altavoz** (se
  aplica el **Volumen de las notificaciones**).
- Gladys 5.2.0 o posterior (el formulario **Opciones…** del widget).
